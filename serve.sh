#!/bin/sh

./build.sh

cd ..

pypy3 ./blake3-wasm-streaming/webserv.py
