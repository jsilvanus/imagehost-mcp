#!/bin/sh
set -e

# Automatically run pending migrations if starting the server and RUN_MIGRATIONS is true
if [ "$1" = "node" ] && [ "$2" = "dist/server.js" ]; then
  if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
    echo "Running database migrations before starting ImageHost..."
    node dist/db/migrate.js || {
      echo "Database migration failed! Exiting."
      exit 1
    }
  fi
fi

exec "$@"
