#!/usr/bin/env python3
from http.server import HTTPServer, SimpleHTTPRequestHandler

class COIHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        super().end_headers()

HTTPServer(('0.0.0.0', 8038), COIHandler).serve_forever()
