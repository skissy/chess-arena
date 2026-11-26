#!/bin/sh
set -eu

mkdir -p dist
cp -R server.js gomoku.js public package.json run.sh dist/
chmod 755 dist/run.sh
