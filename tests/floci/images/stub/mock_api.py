"""Minimal GuardBench API and Demo AI target stand-in served by the stub container.

Every ECS service of the experiment layer and the SageMaker endpoint run this one image,
so the private ALB path, the health checks and the Runner's API calls have something to
answer. It is a test double: it keeps no state beyond counters and judges nothing.
"""

from __future__ import annotations

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("SAGEMAKER_BIND_TO_PORT") or os.environ.get("PORT") or "8080")


class Handler(BaseHTTPRequestHandler):
    suites = 0
    lock = threading.Lock()

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - base class signature
        print(format % args, flush=True)

    def _send(self, status: int, payload: dict | str, content_type: str = "application/json") -> None:
        body = payload.encode() if isinstance(payload, str) else json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _drain_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def do_GET(self) -> None:  # noqa: N802
        if self.path in ("/health", "/ping"):
            self._send(200, "ok", "text/plain")
        elif self.path.startswith("/api/v1/test-suites"):
            self._send(200, {"data": {"items": [], "page": {"hasNext": False}}})
        else:
            self._send(404, {"error": f"not found: {self.path}"})

    def do_POST(self) -> None:  # noqa: N802
        self._drain_body()
        if self.path == "/api/v1/test-suites":
            with Handler.lock:
                Handler.suites += 1
                suite_id = Handler.suites
            self._send(201, {"data": {"id": suite_id}})
        elif self.path in ("/v1/chat/completions", "/invocations"):
            self._send(200, {"choices": [{"message": {"role": "assistant", "content": "ok"}}]})
        else:
            self._send(404, {"error": f"not found: {self.path}"})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
