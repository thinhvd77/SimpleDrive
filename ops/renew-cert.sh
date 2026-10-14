#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
docker compose run --rm certbot renew --webroot -w /var/www/certbot
docker compose exec -T web nginx -s reload
