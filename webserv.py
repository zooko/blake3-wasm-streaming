#!/usr/bin/env python3
import ssl
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

HOST = "0.0.0.0"
PORT = 8038

CERT_FILE = "192.168.1.82+3.pem"
KEY_FILE = "192.168.1.82+3-key.pem"

class COIHandler(SimpleHTTPRequestHandler):
    # Optional: ensure wasm/mjs mime types are correct
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".mjs": "text/javascript",
        ".js": "text/javascript",
    }

    def end_headers(self):
        # Required for SAB / shared wasm memory in workers
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")

        # Helpful with COEP when fetching subresources
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")

        # Avoid stale cache while debugging
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

httpd = ThreadingHTTPServer((HOST, PORT), COIHandler)

ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(certfile=CERT_FILE, keyfile=KEY_FILE)
httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)

print(f"Serving HTTPS on https://{HOST}:{PORT}")
httpd.serve_forever()
