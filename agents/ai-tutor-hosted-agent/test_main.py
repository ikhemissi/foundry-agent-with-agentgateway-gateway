import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import httpx
import yaml
from openai import AsyncOpenAI
from starlette.middleware import Middleware

import main


class AgentTests(unittest.IsolatedAsyncioTestCase):
    def delegated_host(self, respond):
        clients = []

        def factory():
            transport = httpx.AsyncClient(transport=httpx.MockTransport(respond), follow_redirects=False)
            client = AsyncOpenAI(
                base_url="https://gateway.example/delegated/v1",
                api_key=main.read_delegated_gateway_token, http_client=transport, max_retries=0,
            )
            clients.append(client)
            self.addAsyncCleanup(client.close)
            with (
                patch.object(main, "AsyncOpenAI", return_value=client),
                patch.object(main, "DefaultAsyncHttpxClient", return_value=transport),
            ):
                return main.create_agent("https://gateway.example/delegated/v1", main.read_delegated_gateway_token)

        host = main.ResponsesHostServer(
            factory, configure_observability=None, prepare_options=main.prepare_chat_completion_options,
        )
        host.add_middleware(main.DelegatedGatewayAuth)
        return host, clients

    @staticmethod
    def streamed_reply():
        chunk = {
            "id": "delegated-test", "object": "chat.completion.chunk", "created": 1,
            "model": "gpt-5.4-nano",
            "choices": [{"index": 0, "delta": {"role": "assistant", "content": "Delegated answer."},
                         "finish_reason": "stop"}],
        }
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"},
            content=f"data: {json.dumps(chunk)}\n\ndata: [DONE]\n\n",
        )

    async def test_delegated_requests_keep_tokens_isolated_and_out_of_metadata_and_outputs(self):
        captured = []
        headers_seen = []

        async def respond(request):
            captured.append(request)
            await asyncio.sleep(0.02)
            return self.streamed_reply()

        host, clients = self.delegated_host(respond)

        class InspectHeaders(main.BaseHTTPMiddleware):
            async def dispatch(self, request, call_next):
                headers_seen.append(dict(request.headers))
                return await call_next(request)

        host.user_middleware.append(Middleware(InspectHeaders))
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=host), base_url="http://local-agent",
        ) as caller:
            responses = await asyncio.gather(*[
                caller.post("/responses", headers={main.DELEGATED_TOKEN_HEADER: token}, json={
                    "input": question, "store": False, "stream": stream, "include": ["reasoning.encrypted_content"],
                })
                for token, question, stream in [("first-user-token", "First learner", False),
                                                ("second-user-token", "Second learner", True)]
            ])
        self.assertEqual(len(clients), 2)
        self.assertTrue(all(client.is_closed for client in clients))
        self.assertEqual(len(captured), 2)
        for request in captured:
            body = json.loads(request.content)
            is_first = any(message.get("content") == "First learner" for message in body["messages"])
            expected = "first-user-token" if is_first else "second-user-token"
            self.assertEqual(request.headers["authorization"], f"Bearer {expected}")
            self.assertEqual(str(request.url), "https://gateway.example/delegated/v1/chat/completions")
            self.assertNotIn(expected, request.content.decode())
        for response in responses:
            self.assertEqual(response.status_code, 200, response.text)
            self.assertIn("Delegated answer.", response.text)
            self.assertNotIn("first-user-token", response.text)
            self.assertNotIn("second-user-token", response.text)
        self.assertTrue(headers_seen)
        self.assertTrue(all(main.DELEGATED_TOKEN_HEADER not in headers for headers in headers_seen))
        with self.assertRaisesRegex(PermissionError, "request-scoped"):
            await main.read_delegated_gateway_token()

    async def test_delegated_mode_rejects_missing_tokens_storage_and_background_before_model_calls(self):
        respond = Mock(return_value=self.streamed_reply())
        host, clients = self.delegated_host(respond)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=host), base_url="http://local-agent",
        ) as caller:
            for token in [None, "", " ", "Bearer token"]:
                response = await caller.post("/responses", json={"input": "Teach", "store": False},
                                             headers={} if token is None else {main.DELEGATED_TOKEN_HEADER: token})
                self.assertEqual(response.status_code, 401, response.text)
            for options in [{}, {"store": True}, {"store": None}, {"store": False, "background": True}]:
                response = await caller.post("/responses", json={"input": "Teach", **options},
                                             headers={main.DELEGATED_TOKEN_HEADER: "user-token"})
                self.assertEqual(response.status_code, 400, response.text)
            response = await caller.post("/responses", content="not-json",
                                         headers={main.DELEGATED_TOKEN_HEADER: "user-token"})
            self.assertEqual(response.status_code, 400)
            response = await caller.post("/responses", json={"input": "Teach", "store": False}, headers=[
                (main.DELEGATED_TOKEN_HEADER, "first-token"), (main.DELEGATED_TOKEN_HEADER, "second-token"),
            ])
            self.assertEqual(response.status_code, 401)
            ready = await caller.get("/readiness")
            self.assertEqual(ready.status_code, 200)
        respond.assert_not_called()
        self.assertEqual(clients, [])

    async def test_gateway_authentication_failures_and_redirects_never_retry_as_the_agent(self):
        for status in [401, 403, 302]:
            with self.subTest(status=status):
                requests = []

                def respond(request):
                    requests.append(request)
                    return httpx.Response(
                        status, headers={"location": "https://unexpected.example"},
                        json={"error": {"message": "Gateway denied the request.", "type": "authentication_error"}},
                    )

                host, clients = self.delegated_host(respond)
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=host), base_url="http://local-agent",
                ) as caller:
                    response = await caller.post("/responses", headers={main.DELEGATED_TOKEN_HEADER: "denied-user-token"},
                                                 json={"input": "Teach", "store": False})
                self.assertEqual(response.json()["status"], "failed", response.text)
                self.assertEqual(len(requests), 1)
                self.assertEqual(requests[0].headers["authorization"], "Bearer denied-user-token")
                self.assertFalse(clients[0]._client.follow_redirects)
                self.assertTrue(clients[0].is_closed)

    async def test_cancelled_delegated_requests_do_not_leak_tokens_into_the_next_request(self):
        started = asyncio.Event()
        never_finishes = asyncio.Event()
        requests = []

        async def respond(request):
            requests.append(request)
            if request.headers["authorization"] == "Bearer cancelled-user-token":
                started.set()
                await never_finishes.wait()
            return self.streamed_reply()

        host, clients = self.delegated_host(respond)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=host), base_url="http://local-agent",
        ) as caller:
            task = asyncio.create_task(caller.post("/responses", json={"input": "Teach", "store": False},
                                                  headers={main.DELEGATED_TOKEN_HEADER: "cancelled-user-token"}))
            await asyncio.wait_for(started.wait(), timeout=5)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            response = await caller.post("/responses", json={"input": "Teach again", "store": False},
                                         headers={main.DELEGATED_TOKEN_HEADER: "next-user-token"})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["status"], "completed")
        self.assertEqual(requests[-1].headers["authorization"], "Bearer next-user-token")
        self.assertTrue(all(client.is_closed for client in clients))
        with self.assertRaises(PermissionError):
            await main.read_delegated_gateway_token()

    async def test_delegated_startup_uses_a_factory_without_agent_tokens_or_key_vault(self):
        with (
            patch.dict(main.os.environ, {
                "AGENTGATEWAY_AUTH_MODE": "entra_delegated",
                "AGENTGATEWAY_BASE_URL": "https://gateway.example/delegated/v1",
                "APPLICATIONINSIGHTS_CONNECTION_STRING": "test-destination",
            }),
            patch.object(main, "DefaultAzureCredential") as credentials,
            patch.object(main, "SecretClient") as vault,
            patch.object(main, "configure_azure_monitor"),
            patch.object(main, "enable_instrumentation"),
            patch.object(main, "create_agent") as create,
            patch.object(main, "ResponsesHostServer") as server,
        ):
            main.main()
            create.assert_not_called()
            server.call_args.args[0]()
            self.assertIs(create.call_args.args[1], main.read_delegated_gateway_token)
            server.return_value.add_middleware.assert_called_once_with(main.DelegatedGatewayAuth)
            self.assertIs(server.call_args.kwargs["prepare_options"], main.prepare_chat_completion_options)
            credentials.return_value.__enter__.return_value.get_token.assert_not_called()
            vault.assert_not_called()
            self.assertIn(main.DELEGATED_TOKEN_HEADER,
                          main.os.environ["OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SANITIZE_FIELDS"])

    def test_azd_wires_both_paths_without_packaging_credentials(self):
        root = Path(__file__).resolve().parents[2]
        manifest = yaml.safe_load((root / "azure.yaml").read_text())
        self.assertEqual(list(manifest["services"]), ["ai-tutor-hosted-agent"])
        service = manifest["services"]["ai-tutor-hosted-agent"]
        self.assertEqual(service["host"], "azure.ai.agent")
        self.assertEqual(service["project"], "agents/ai-tutor-hosted-agent")
        self.assertEqual(service["codeConfiguration"], {
            "runtime": "python_3_13", "entryPoint": "main.py", "dependencyResolution": "remote_build",
        })
        self.assertEqual(service["protocols"], [{"protocol": "responses", "version": "2.0.0"}])
        self.assertEqual(service["env"]["AGENTGATEWAY_BASE_URL"], "${AGENTGATEWAY_HOSTED_BASE_URL}")
        self.assertEqual(service["env"]["AGENTGATEWAY_AUTH_MODE"], "${AGENTGATEWAY_AUTH_MODE}")
        self.assertEqual(service["env"]["AGENTGATEWAY_TOKEN_SCOPE"], "${AGENTGATEWAY_TOKEN_SCOPE}")
        self.assertNotIn("AGENTGATEWAY_API_KEY", service["env"])
        self.assertEqual(manifest["hooks"]["postdeploy"]["run"], "node scripts/deploy-prompt-agent.mjs")
        provision = manifest["hooks"]["postprovision"]["run"]
        self.assertTrue(provision.startswith("set -eu"))
        self.assertIn("az containerapp revision restart", provision)
        self.assertTrue(provision.rstrip().endswith("node scripts/deploy-prompt-agent.mjs"))
        access = service["hooks"]["postdeploy"]
        self.assertEqual(access["dir"], "../..")
        self.assertEqual(access["run"], "node scripts/grant-hosted-agent-access.mjs")
        for path in [
            service["project"] + "/" + service["codeConfiguration"]["entryPoint"],
            "scripts/deploy-prompt-agent.mjs", "scripts/grant-hosted-agent-access.mjs",
        ]:
            self.assertTrue((root / path).is_file(), path)
        ignored = (Path(__file__).parent / ".agentignore").read_text().splitlines()
        for pattern in [".env", ".env.*", ".venv/", "test_*.py"]:
            self.assertIn(pattern, ignored)

    async def test_inference_uses_gateway_alias_instructions_and_lazy_rotating_key(self):
        requests = []
        key = AsyncMock(side_effect=["first-gateway-key", "rotated-gateway-key"])

        def respond(request):
            requests.append(request)
            return httpx.Response(200, json={
                "id": "chatcmpl-test",
                "object": "chat.completion",
                "created": 1,
                "model": "gpt-5.4-nano",
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": "Try dividing both sides by two."},
                    "finish_reason": "stop",
                }],
                "usage": {"prompt_tokens": 4, "completion_tokens": 8, "total_tokens": 12},
            })

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as transport:
            client = AsyncOpenAI(base_url="https://gateway.example/v1", api_key=key, http_client=transport)
            with patch.object(main, "AsyncOpenAI", return_value=client):
                agent = main.create_agent("https://gateway.example/v1", key)
            key.assert_not_awaited()
            for _ in range(2):
                result = await agent.run("How do I solve 2x = 6?")
                self.assertIn("dividing", result.text)

        self.assertEqual(len(requests), 2)
        self.assertEqual(key.await_count, 2)
        for request, expected_key in zip(requests, ["first-gateway-key", "rotated-gateway-key"]):
            self.assertEqual(str(request.url), "https://gateway.example/v1/chat/completions")
            self.assertEqual(request.headers["authorization"], f"Bearer {expected_key}")
            body = json.loads(request.content)
            self.assertEqual(body["model"], "gpt-5.4-nano")
            self.assertTrue(any("patient" in str(message.get("content", "")) for message in body["messages"]))

    async def test_bad_endpoints_fail_before_client_creation(self):
        for endpoint in [
            "http://gateway.example/v1", "https://gateway.example",
            "https://gateway.example/v1/chat/completions",
            "https://user:secret@gateway.example/v1", "https://gateway.example/v1?key=secret",
            "https://gateway.example/v1#fragment", "/v1",
        ]:
            with self.subTest(endpoint=endpoint), patch.object(main, "AsyncOpenAI") as client:
                with self.assertRaisesRegex(ValueError, "HTTPS gateway"):
                    main.create_agent(endpoint, AsyncMock(return_value="key"))
                client.assert_not_called()

    async def test_responses_host_translates_client_requests_to_gateway_chat_completions(self):
        requests = []
        key = AsyncMock(return_value="local-test-key")

        def respond(request):
            requests.append(request)
            chunks = []
            for delta, finish_reason in [
                ({"role": "assistant", "content": "Six divided by two is three."}, None),
                ({}, "stop"),
            ]:
                chunks.append("data: " + json.dumps({
                    "id": "chatcmpl-host-test", "object": "chat.completion.chunk", "created": 1,
                    "model": "gpt-5.4-nano",
                    "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
                }) + "\n\n")
            return httpx.Response(
                200, headers={"content-type": "text/event-stream"},
                content="".join(chunks) + "data: [DONE]\n\n",
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as upstream:
            client = AsyncOpenAI(base_url="https://gateway.example/v1", api_key=key, http_client=upstream)
            with patch.object(main, "AsyncOpenAI", return_value=client):
                agent = main.create_agent("https://gateway.example/v1", key)
            host = main.ResponsesHostServer(
                agent, configure_observability=None, prepare_options=main.prepare_chat_completion_options,
            )
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=host), base_url="http://local-agent",
            ) as caller:
                for stream in [False, True]:
                    for include in [[], ["reasoning.encrypted_content"]]:
                        with self.subTest(stream=stream, include=include):
                            response = await caller.post("/responses", json={
                                "input": "Solve 2x = 6", "stream": stream, "store": False,
                                "include": include, "temperature": 0.2, "top_p": 0.8, "max_output_tokens": 100,
                            })
                            self.assertEqual(response.status_code, 200, response.text)
                            if stream:
                                self.assertIn("response.completed", response.text)
                                self.assertNotIn("response.failed", response.text)
                            else:
                                result = response.json()
                                self.assertEqual(result["object"], "response")
                                self.assertEqual(result["status"], "completed", result)
                            self.assertIn("Six divided by two", response.text)
            self.assertEqual(len(requests), 4)
            for request in requests:
                self.assertEqual(str(request.url), "https://gateway.example/v1/chat/completions")
                body = json.loads(request.content)
                self.assertNotIn("include", body)
                self.assertEqual(body["temperature"], 0.2)
                self.assertEqual(body["top_p"], 0.8)
                self.assertEqual(body["max_completion_tokens"], 100)

    def test_response_option_preparation_only_removes_include_without_mutating_input(self):
        for include in [[], ["reasoning.encrypted_content"]]:
            options = {"include": include, "temperature": 0.2, "provider_option": {"enabled": True}}
            with self.assertLogs(main.__name__, level="WARNING") as logs:
                result = main.prepare_chat_completion_options(Mock(), options)
            self.assertEqual(result, {"temperature": 0.2, "provider_option": {"enabled": True}})
            self.assertEqual(options["include"], include)
            self.assertIn("'include'", logs.output[0])
        options = {"temperature": 0.2}
        self.assertEqual(main.prepare_chat_completion_options(Mock(), options), options)

    async def test_invalid_definitions_fail_explicitly(self):
        definition = {"name": "tutor", "model": "gpt-5.4-nano", "instructions": "Teach."}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "agent.json"
            for field in definition:
                for value in [None, "", "  ", 123]:
                    with self.subTest(field=field, value=value):
                        path.write_text(json.dumps({**definition, field: value}))
                        with self.assertRaisesRegex(ValueError, field):
                            main.create_agent("https://gateway.example/v1", AsyncMock(), path)
            path.write_text(json.dumps({**definition, "model": "connection/model"}))
            with self.assertRaisesRegex(ValueError, "direct gateway model alias"):
                main.create_agent("https://gateway.example/v1", AsyncMock(), path)

    async def test_key_vault_read_is_lazy_and_empty_values_fail(self):
        vault = Mock()
        vault.get_secret.return_value = SimpleNamespace(value="gateway-key")
        self.assertEqual(await main.read_gateway_key(vault), "gateway-key")
        vault.get_secret.assert_called_once_with("agentgateway-api-key")
        for value in [None, "", "   "]:
            vault.get_secret.return_value = SimpleNamespace(value=value)
            with self.assertRaisesRegex(RuntimeError, "empty agentgateway-api-key"):
                await main.read_gateway_key(vault)

    async def test_key_vault_errors_propagate(self):
        vault = Mock()
        vault.get_secret.side_effect = RuntimeError("access denied")
        with self.assertRaisesRegex(RuntimeError, "access denied"):
            await main.read_gateway_key(vault)

    async def test_entra_tokens_are_requested_lazily_and_errors_do_not_fall_back_to_keys(self):
        credential = Mock()
        credential.get_token.return_value = SimpleNamespace(token="gateway-user-or-agent-token")
        scope = "api://11111111-1111-1111-1111-111111111111/.default"
        self.assertEqual(await main.read_gateway_token(credential, scope), "gateway-user-or-agent-token")
        credential.get_token.assert_called_once_with(scope)
        for value in [None, "", " "]:
            credential.get_token.return_value = SimpleNamespace(token=value)
            with self.assertRaisesRegex(RuntimeError, "empty gateway access token"):
                await main.read_gateway_token(credential, scope)
        for invalid in ["", "https://management.azure.com/.default", "api://application"]:
            with self.assertRaisesRegex(ValueError, "TOKEN_SCOPE"):
                await main.read_gateway_token(credential, invalid)
        credential.get_token.side_effect = RuntimeError("token denied")
        with self.assertRaisesRegex(RuntimeError, "token denied"):
            await main.read_gateway_token(credential, scope)

    async def test_entra_startup_does_not_open_key_vault(self):
        with (
            patch.dict(main.os.environ, {
                "AGENTGATEWAY_AUTH_MODE": "entra",
                "AGENTGATEWAY_TOKEN_SCOPE": "api://gateway/.default",
                "AGENTGATEWAY_BASE_URL": "https://gateway.example/entra/v1",
                "APPLICATIONINSIGHTS_CONNECTION_STRING": "test-destination",
            }),
            patch.object(main, "DefaultAzureCredential") as credential_factory,
            patch.object(main, "SecretClient") as vault,
            patch.object(main, "configure_azure_monitor"),
            patch.object(main, "enable_instrumentation"),
            patch.object(main, "create_agent") as create,
            patch.object(main, "ResponsesHostServer") as server,
        ):
            main.main()
            vault.assert_not_called()
            credential = credential_factory.return_value.__enter__.return_value
            credential.get_token.assert_not_called()
            credential.get_token.return_value = SimpleNamespace(token="new-token")
            self.assertEqual(await create.call_args.args[1](), "new-token")
            credential.get_token.assert_called_once_with("api://gateway/.default")
            self.assertIs(server.call_args.kwargs["prepare_options"], main.prepare_chat_completion_options)

    def test_startup_keeps_explicit_identity_exporter_and_disables_message_capture(self):
        with (
            patch.dict(main.os.environ, {
                "AGENTGATEWAY_BASE_URL": "https://gateway.example/v1",
                "AGENTGATEWAY_AUTH_MODE": "api_key",
                "AZURE_KEY_VAULT_NAME": "test-vault",
                "APPLICATIONINSIGHTS_CONNECTION_STRING": "test-destination",
            }),
            patch.object(main, "DefaultAzureCredential") as credential_factory,
            patch.object(main, "SecretClient") as vault_factory,
            patch.object(main, "configure_azure_monitor") as configure,
            patch.object(main, "enable_instrumentation") as instrumentation,
            patch.object(main, "create_agent") as create,
            patch.object(main, "ResponsesHostServer") as server,
        ):
            main.main()
            credential = credential_factory.return_value.__enter__.return_value
            configure.assert_called_once_with(
                connection_string="test-destination", credential=credential, enable_live_metrics=False,
            )
            instrumentation.assert_called_once_with(enable_sensitive_data=False, enable_message_events=False)
            vault_factory.return_value.__enter__.return_value.get_secret.assert_not_called()
            self.assertEqual(create.call_args.args[0], "https://gateway.example/v1")
            server.assert_called_once_with(
                create.return_value, configure_observability=None,
                prepare_options=main.prepare_chat_completion_options,
            )
            server.return_value.run.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
