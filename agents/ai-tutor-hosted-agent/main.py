import asyncio
import json
import logging
import os
from collections.abc import Awaitable, Callable
from contextlib import ExitStack
from contextvars import ContextVar
from pathlib import Path
from types import TracebackType
from typing import Self
from urllib.parse import urlparse

from agent_framework import Agent
from agent_framework.observability import enable_instrumentation
from agent_framework.openai import OpenAIChatCompletionClient
from agent_framework_foundry_hosting import ResponsesHostServer
from azure.identity import DefaultAzureCredential
from azure.core.credentials import TokenCredential
from azure.keyvault.secrets import SecretClient
from azure.monitor.opentelemetry import configure_azure_monitor
from openai import AsyncOpenAI, DefaultAsyncHttpxClient
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response


DELEGATED_TOKEN_HEADER = "x-client-agentgateway-access-token"
_delegated_token: ContextVar[str | None] = ContextVar("delegated_gateway_token", default=None)


class DelegatedGatewayAuth(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        if request.method != "POST" or request.url.path.rstrip("/") != "/responses":
            return await call_next(request)
        values = request.headers.getlist(DELEGATED_TOKEN_HEADER)
        token = values[0] if len(values) == 1 else ""
        if not token or any(character.isspace() for character in token):
            return JSONResponse(
                {"error": {"message": f"A single delegated token in {DELEGATED_TOKEN_HEADER} is required."}},
                status_code=401,
            )
        try:
            body = await request.json()
        except (json.JSONDecodeError, UnicodeDecodeError):
            return JSONResponse({"error": {"message": "A JSON Responses request is required."}}, status_code=400)
        if not isinstance(body, dict) or body.get("store", True) is not False or body.get("background", False) is not False:
            return JSONResponse(
                {"error": {"message": "Delegated requests require store=false and background=false."}},
                status_code=400,
            )
        # Keep bearer tokens out of the adapter's request metadata and recovery storage.
        request.scope["headers"] = [
            (name, value) for name, value in request.scope["headers"]
            if name.lower() != DELEGATED_TOKEN_HEADER.encode("ascii")
        ]
        context = _delegated_token.set(token)
        try:
            return await call_next(request)
        finally:
            _delegated_token.reset(context)


async def read_delegated_gateway_token() -> str:
    token = _delegated_token.get()
    if not token:
        raise PermissionError("A request-scoped delegated gateway token is required.")
    return token


class GatewayChatCompletionClient(OpenAIChatCompletionClient):
    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(
        self, exc_type: type[BaseException] | None, exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        await self.client.close()


def create_agent(
    base_url: str,
    get_api_key: Callable[[], Awaitable[str]],
    definition_path: Path = Path(__file__).with_name("agent.json"),
) -> Agent:
    endpoint = urlparse(base_url)
    if (
        endpoint.scheme != "https"
        or not endpoint.hostname
        or endpoint.path.rstrip("/") not in ("/v1", "/entra/v1", "/delegated/v1")
        or endpoint.username
        or endpoint.password
        or endpoint.query
        or endpoint.fragment
    ):
        raise ValueError("AGENTGATEWAY_BASE_URL must be an HTTPS gateway /v1, /entra/v1 or /delegated/v1 endpoint.")
    definition = json.loads(definition_path.read_text(encoding="utf-8"))
    for field in ("name", "model", "instructions"):
        if not isinstance(definition.get(field), str) or not definition[field].strip():
            raise ValueError(f"agent.json requires a nonempty {field}.")
    if "/" in definition["model"]:
        raise ValueError("The hosted agent requires a direct gateway model alias, without a connection prefix.")
    client = GatewayChatCompletionClient(
        model=definition["model"],
        async_client=AsyncOpenAI(
            base_url=base_url, api_key=get_api_key,
            http_client=DefaultAsyncHttpxClient(follow_redirects=False),
        ),
    )
    return Agent(
        client=client,
        name=definition["name"],
        instructions=definition["instructions"],
    )


async def read_gateway_key(vault: SecretClient) -> str:
    # RBAC is assigned after deployment; resolve the credential on model requests.
    secret = await asyncio.to_thread(vault.get_secret, "agentgateway-api-key")
    if not secret.value or not secret.value.strip():
        raise RuntimeError("Key Vault returned an empty agentgateway-api-key.")
    return secret.value


async def read_gateway_token(credential: TokenCredential, scope: str) -> str:
    if not scope.startswith("api://") or not scope.endswith("/.default"):
        raise ValueError("AGENTGATEWAY_TOKEN_SCOPE must be an api:// application /.default scope.")
    token = await asyncio.to_thread(credential.get_token, scope)
    if not token.token or not token.token.strip():
        raise RuntimeError("Entra returned an empty gateway access token.")
    return token.token


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    logging.getLogger("azure.core.pipeline.policies.http_logging_policy").setLevel(logging.WARNING)
    auth_mode = os.environ.get("AGENTGATEWAY_AUTH_MODE", "api_key")
    if auth_mode not in ("api_key", "entra", "entra_delegated"):
        raise ValueError("AGENTGATEWAY_AUTH_MODE must be api_key, entra or entra_delegated.")
    base_url = os.environ["AGENTGATEWAY_BASE_URL"]
    if auth_mode == "entra_delegated" and urlparse(base_url).path.rstrip("/") != "/delegated/v1":
        raise ValueError("Delegated authentication requires the gateway /delegated/v1 endpoint.")
    with ExitStack() as stack:
        credential = stack.enter_context(DefaultAzureCredential())
        if auth_mode == "entra_delegated":
            get_api_key = read_delegated_gateway_token
        elif auth_mode == "entra":
            scope = os.environ["AGENTGATEWAY_TOKEN_SCOPE"]

            async def get_api_key() -> str:
                return await read_gateway_token(credential, scope)
        else:
            vault = stack.enter_context(SecretClient(
                vault_url=f"https://{os.environ['AZURE_KEY_VAULT_NAME']}.vault.azure.net",
                credential=credential,
            ))

            async def get_api_key() -> str:
                return await read_gateway_key(vault)

        os.environ["OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SANITIZE_FIELDS"] = ",".join(filter(None, [
            os.environ.get("OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SANITIZE_FIELDS"),
            "authorization", DELEGATED_TOKEN_HEADER,
        ]))
        configure_azure_monitor(
            connection_string=os.environ["APPLICATIONINSIGHTS_CONNECTION_STRING"],
            credential=credential,
            enable_live_metrics=False,
        )
        enable_instrumentation(enable_sensitive_data=False, enable_message_events=False)

        if auth_mode == "entra_delegated":
            # Each request owns its OpenAI client and its mutable authentication state.
            server = ResponsesHostServer(
                lambda: create_agent(base_url, get_api_key), configure_observability=None,
            )
            server.add_middleware(DelegatedGatewayAuth)
        else:
            agent = create_agent(base_url, get_api_key)
            server = ResponsesHostServer(agent, configure_observability=None)
        server.run()


if __name__ == "__main__":
    main()
