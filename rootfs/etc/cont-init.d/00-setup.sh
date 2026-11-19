#!/command/with-contenv bashio
# Ensure /data has a working directory for the add-on.
set -e

# Home Assistant add-ons persist /data across restarts. The app folder
# itself is read-only (baked into the image), so nothing to do here yet.
# This hook exists so future per-instance config (e.g. swapping models)
# can be added without rebuilding.
bashio::log.info "Cactus Mirage add-on starting up."
