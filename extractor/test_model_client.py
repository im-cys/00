# -*- coding: utf-8 -*-
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from run_extract import (  # noqa: E402
    ModelRequestError,
    TransientModelError,
    call_llm,
    call_llm_resilient,
)


class ModelClientTest(unittest.TestCase):
    @patch("run_extract.get_config")
    @patch("requests.post")
    def test_deepseek_v4_disables_thinking_and_limits_json_output(self, post, config):
        config.return_value = {
            "base": "https://api.deepseek.com",
            "key": "test-key",
            "model": "deepseek-v4-pro",
            "sleep": 0,
        }
        response = Mock(status_code=200, text='{"ok":true}')
        response.json.return_value = {
            "choices": [{"message": {"content": '{"ok":true}'}}]
        }
        post.return_value = response
        with patch.dict(os.environ, {"EXTRACT_MAX_TOKENS": "16000"}, clear=False):
            self.assertEqual(call_llm([{"role": "user", "content": "json"}]), '{"ok":true}')
        payload = post.call_args.kwargs["json"]
        self.assertEqual(payload["thinking"], {"type": "disabled"})
        self.assertEqual(payload["response_format"], {"type": "json_object"})
        self.assertEqual(payload["max_tokens"], 16000)

    @patch("run_extract.call_llm")
    def test_non_retryable_account_error_stops_after_one_attempt(self, call):
        call.side_effect = ModelRequestError("HTTP 402: insufficient balance")
        with self.assertRaises(ModelRequestError):
            call_llm_resilient([], max_attempts=12)
        self.assertEqual(call.call_count, 1)

    @patch("run_extract.time.sleep")
    @patch("run_extract.call_llm")
    def test_transient_empty_response_is_retried(self, call, sleep):
        call.side_effect = [TransientModelError("模型返回空 content"), '{"ok":true}']
        self.assertEqual(call_llm_resilient([], max_attempts=3), '{"ok":true}')
        self.assertEqual(call.call_count, 2)
        sleep.assert_called_once()


if __name__ == "__main__":
    unittest.main()
