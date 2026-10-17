import json
import logging
import os
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from pathlib import Path
from types import TracebackType
from typing import Any, Self
from urllib.parse import urlparse

from agent_framework import Agent
from agent_framework.observability import enable_instrumentation
from agent_framework.openai import OpenAIChatCompletionClient
from agent_framework_foundry_hosting import HostedResponseRequest, ResponsesHostServer
from azure.identity import DefaultAzureCredential
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


def prepare_chat_completion_options(
    _request: HostedResponseRequest, options: dict[str, Any],
) -> dict[str, Any]:
    if "include" in options:
        options = dict(options)
        options.pop("include")
        logging.getLogger(__name__).warning(
            "Responses 'include' projections are not supported by the Chat Completions gateway and will be ignored."
        )
    return options


def create_agent(
    base_url: str,
    get_access_token: Callable[[], Awaitable[str]],
    definition_path: Path = Path(__file__).with_name("agent.json"),
) -> Agent:
    endpoint = urlparse(base_url)
    if (
        endpoint.scheme != "https"
        or not endpoint.hostname
        or endpoint.path.rstrip("/") != "/delegated/v1"
        or endpoint.username
        or endpoint.password
        or endpoint.query
        or endpoint.fragment
    ):
        raise ValueError("AGENTGATEWAY_BASE_URL must be an HTTPS gateway /delegated/v1 endpoint.")
    definition = json.loads(definition_path.read_text(encoding="utf-8"))
    for field in ("name", "model", "instructions"):
        if not isinstance(definition.get(field), str) or not definition[field].strip():
            raise ValueError(f"agent.json requires a nonempty {field}.")
    if "/" in definition["model"]:
        raise ValueError("The hosted agent requires a direct gateway model alias, without a connection prefix.")
    client = GatewayChatCompletionClient(
        model=definition["model"],
        async_client=AsyncOpenAI(
            base_url=base_url, api_key=get_access_token,
            http_client=DefaultAsyncHttpxClient(follow_redirects=False),
        ),
    )
    return Agent(
        client=client,
        name=definition["name"],
        instructions=definition["instructions"],
    )


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    logging.getLogger("azure.core.pipeline.policies.http_logging_policy").setLevel(logging.WARNING)
    if os.environ.get("AGENTGATEWAY_AUTH_MODE", "entra_delegated") != "entra_delegated":
        raise ValueError("Only delegated Entra authentication is supported; remove the obsolete AGENTGATEWAY_AUTH_MODE setting.")
    base_url = os.environ["AGENTGATEWAY_BASE_URL"]
    if urlparse(base_url).path.rstrip("/") != "/delegated/v1":
        raise ValueError("Delegated authentication requires the gateway /delegated/v1 endpoint.")
    with DefaultAzureCredential() as credential:
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

        # Each request owns its OpenAI client and its mutable authentication state.
        server = ResponsesHostServer(
            lambda: create_agent(base_url, read_delegated_gateway_token), configure_observability=None,
            prepare_options=prepare_chat_completion_options,
        )
        server.add_middleware(DelegatedGatewayAuth)
        server.run()


if __name__ == "__main__":
    main()
