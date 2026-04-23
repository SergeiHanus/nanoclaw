#!/bin/bash
# Build the NanoClaw agent container image.
#
# Reads one optional build flag from ../.env:
#   INSTALL_CJK_FONTS=true   — add Chinese/Japanese/Korean fonts (~200MB)
# setup/container.ts reads the same file, so both build paths stay in sync.
# Callers can also override by exporting INSTALL_CJK_FONTS directly.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

# Derive the image name from the project root so two NanoClaw installs on the
# same host don't overwrite each other's `nanoclaw-agent:latest` tag. Matches
# setup/lib/install-slug.sh + src/install-slug.ts.
# shellcheck source=../setup/lib/install-slug.sh
source "$PROJECT_ROOT/setup/lib/install-slug.sh"
IMAGE_NAME="$(container_image_base)"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-}"

# Caller's env takes precedence; fall back to .env for both CONTAINER_RUNTIME and INSTALL_CJK_FONTS.
if [ -f "../.env" ]; then
    if [ -z "${CONTAINER_RUNTIME:-}" ]; then
        CONTAINER_RUNTIME="$(grep '^CONTAINER_RUNTIME=' ../.env | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]')"
    fi
    if [ -z "${INSTALL_CJK_FONTS:-}" ]; then
        INSTALL_CJK_FONTS="$(grep '^INSTALL_CJK_FONTS=' ../.env | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]')"
    fi
fi
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

BUILD_ARGS=()
if [ "${INSTALL_CJK_FONTS:-false}" = "true" ]; then
    echo "CJK fonts: enabled (adds ~200MB)"
    BUILD_ARGS+=(--build-arg INSTALL_CJK_FONTS=true)
fi

# Podman on Linux with SELinux needs --security-opt label=disable on build,
# otherwise /bin/sh inside the build fails with "cannot apply additional memory
# protection after relocation: Permission denied".
SECURITY_OPTS=()
if [ "$CONTAINER_RUNTIME" = "podman" ] && [ "$(uname -s)" = "Linux" ]; then
    SECURITY_OPTS+=(--security-opt label=disable)
fi

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"
echo "Runtime: ${CONTAINER_RUNTIME}"

${CONTAINER_RUNTIME} build "${SECURITY_OPTS[@]}" "${BUILD_ARGS[@]}" -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
