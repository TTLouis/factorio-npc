# Shared helpers for running Docker inside a sandboxed cloud container such as
# Claude Code on the web. Source this file; it defines no side effects on load
# beyond reading configuration.
#
#   - ensure_dockerd starts a local dockerd when no daemon is reachable and
#     pulls base images through a registry mirror, because anonymous Docker Hub
#     pulls from shared egress IPs are routinely rate-limited (HTTP 429);
#   - cloud_docker_build builds with host networking and the proxy variables
#     when an HTTPS egress proxy is configured, and trusts the sandbox CA bundle
#     through a generated copy of the Dockerfile. Committed Dockerfiles are not
#     modified.
#
# Environment:
#   E2E_REGISTRY_MIRROR  mirror used when dockerd is started here
#                        (default: https://mirror.gcr.io)
#   E2E_PROXY_CA         extra CA bundle to trust (default:
#                        /root/.ccr/ca-bundle.crt when present)

CLOUD_REGISTRY_MIRROR="${E2E_REGISTRY_MIRROR:-https://mirror.gcr.io}"
CLOUD_PROXY_CA="${E2E_PROXY_CA:-}"
if [[ -z "$CLOUD_PROXY_CA" && -f /root/.ccr/ca-bundle.crt ]]; then
  CLOUD_PROXY_CA=/root/.ccr/ca-bundle.crt
fi
CLOUD_PROXY="${HTTPS_PROXY:-${https_proxy:-}}"
CLOUD_NOPROXY="${NO_PROXY:-${no_proxy:-}}"

cloud_log() { printf '[%s] %s\n' "${CLOUD_LOG_TAG:-cloud}" "$*"; }

ensure_dockerd() {
  if docker info >/dev/null 2>&1; then
    return
  fi
  command -v dockerd >/dev/null || { cloud_log 'no reachable Docker daemon and dockerd is not installed'; exit 1; }
  if [[ ! -f /etc/docker/daemon.json && -n "$CLOUD_REGISTRY_MIRROR" ]]; then
    mkdir -p /etc/docker
    printf '{"registry-mirrors":["%s"]}\n' "$CLOUD_REGISTRY_MIRROR" >/etc/docker/daemon.json
  fi
  cloud_log 'starting dockerd'
  nohup dockerd >/tmp/dockerd.log 2>&1 &
  for _ in $(seq 1 60); do
    docker info >/dev/null 2>&1 && return
    sleep 1
  done
  cloud_log 'dockerd did not become ready; see /tmp/dockerd.log'
  tail -20 /tmp/dockerd.log >&2 || true
  exit 1
}

# cloud_docker_build <dockerfile> <context> <tag> [extra docker build args...]
cloud_docker_build() {
  local dockerfile="$1" context="$2" tag="$3"
  shift 3
  local args=(build -t "$tag" "$@")

  if [[ -n "$CLOUD_PROXY" ]]; then
    # The sandbox proxy listens on the host loopback, so build steps need the
    # host network namespace to reach it.
    args+=(--network host
      --build-arg "HTTPS_PROXY=$CLOUD_PROXY" --build-arg "https_proxy=$CLOUD_PROXY"
      --build-arg "NO_PROXY=$CLOUD_NOPROXY" --build-arg "no_proxy=$CLOUD_NOPROXY")
  fi

  if [[ -n "$CLOUD_PROXY_CA" ]]; then
    # Install the CA bundle right after every FROM. ca-certificates' postinst
    # (slim images) or update-ca-certificates (full images) fold it into the
    # system store; Node gets it explicitly, including at container runtime.
    local work
    work="$(mktemp -d)"
    awk '
      { print }
      /^FROM / {
        print "COPY --from=cloud_proxy_ca ca.crt /usr/local/share/ca-certificates/cloud-proxy-ca.crt"
        print "ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/cloud-proxy-ca.crt"
        print "RUN if command -v update-ca-certificates >/dev/null; then update-ca-certificates >/dev/null; fi"
      }
    ' "$dockerfile" >"$work/Dockerfile"
    mkdir -p "$work/ca"
    cp "$CLOUD_PROXY_CA" "$work/ca/ca.crt"
    args+=(--build-context "cloud_proxy_ca=$work/ca")
    dockerfile="$work/Dockerfile"
    cloud_log "trusting CA bundle $CLOUD_PROXY_CA inside the build"
  fi

  args+=(-f "$dockerfile" "$context")
  cloud_log "building $tag"
  docker "${args[@]}"
}
