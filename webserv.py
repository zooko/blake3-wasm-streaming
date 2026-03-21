#!/usr/bin/env python3
import ssl
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

HOST = "0.0.0.0"
PORT = 8038

SERVER_NAME = "Donalds-MacBook-Pro.local"
CERT_FILE = "dev.pem"
KEY_FILE = "dev-key.pem"

class COIHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".mjs": "text/javascript",
        ".js": "text/javascript",
    }

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

httpd = ThreadingHTTPServer((HOST, PORT), COIHandler)

ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
print("about to load %s %s" % (CERT_FILE, KEY_FILE))
ctx.load_cert_chain(certfile=CERT_FILE, keyfile=KEY_FILE)
httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)

print(f"Serving HTTPS on https://{SERVER_NAME}:{PORT}")
httpd.serve_forever()
