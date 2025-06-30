#!/bin/bash
# Script to clone to local mcp-servers directory
cd /Users/snnalgz/Development/mcp-servers/
git clone https://github.com/snnalgz/mcp-server-elasticsearch.git
cd mcp-server-elasticsearch
npm install
npm run build
echo "Elasticsearch MCP server ready!"
