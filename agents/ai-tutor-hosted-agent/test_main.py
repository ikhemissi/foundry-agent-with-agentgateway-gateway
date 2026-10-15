import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import httpx
import yaml
from openai import AsyncOpenAI

import main


class AgentTests(unittest.IsolatedAsyncioTestCase):
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
        self.assertEqual(service["env"]["AGENTGATEWAY_BASE_URL"], "${AGENTGATEWAY_ENDPOINT}/v1")
        self.assertNotIn("AGENTGATEWAY_API_KEY", service["env"])
        for hook in ["postprovision", "postdeploy"]:
            self.assertEqual(manifest["hooks"][hook]["run"], "node scripts/deploy-prompt-agent.mjs")
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
            host = main.ResponsesHostServer(agent, configure_observability=None)
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=host), base_url="http://local-agent",
            ) as caller:
                response = await caller.post("/responses", json={
                    "input": "Solve 2x = 6", "stream": False, "store": False,
                })
            self.assertEqual(response.status_code, 200, response.text)
            result = response.json()
            self.assertEqual(result["object"], "response")
            self.assertEqual(result["status"], "completed", result)
            self.assertIn("Six divided by two", json.dumps(result["output"]))
            self.assertEqual(len(requests), 1)
            self.assertEqual(str(requests[0].url), "https://gateway.example/v1/chat/completions")

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

    def test_startup_keeps_explicit_identity_exporter_and_disables_message_capture(self):
        with (
            patch.dict(main.os.environ, {
                "AGENTGATEWAY_BASE_URL": "https://gateway.example/v1",
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
            server.assert_called_once_with(create.return_value, configure_observability=None)
            server.return_value.run.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
