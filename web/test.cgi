#!/bin/sh
echo "Content-Type: text/plain"
echo ""
echo "CGI works."
echo "SERVER_SOFTWARE=$SERVER_SOFTWARE"
echo "GATEWAY_INTERFACE=$GATEWAY_INTERFACE"
echo "REQUEST_URI=$REQUEST_URI"
