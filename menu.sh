#!/usr/bin/env bash
# menu.sh — interactive wrapper for route-shot
# Usage: chmod +x menu.sh && ./menu.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRAWLER="$SCRIPT_DIR/route-shot.js"
OUTPUT_DIR="$SCRIPT_DIR/screenshots"
SERVER_PORT="${ROUTE_SHOT_PORT:-8000}"
SERVER_PID_FILE="$SCRIPT_DIR/.server.pid"
LAST_URL_FILE="$SCRIPT_DIR/.last-url"

# URL precedence: $1 (CLI arg) > $START_URL > remembered > default
CLI_URL="${1:-}"
REMEMBERED_URL=""
[ -f "$LAST_URL_FILE" ] && REMEMBERED_URL="$(cat "$LAST_URL_FILE")"
DEFAULT_URL="${CLI_URL:-${START_URL:-${REMEMBERED_URL:-http://localhost:3000}}}"

# colors
R=$'\033[0;31m'; G=$'\033[0;32m'; Y=$'\033[1;33m'; B=$'\033[0;34m'
BOLD=$'\033[1m'; NC=$'\033[0m'

# --- helpers ----------------------------------------------------------------

check_one() {
    local label="$1"; shift
    if "$@" >/dev/null 2>&1; then
        printf "  ${G}✓${NC} %s\n" "$label"
        return 0
    else
        printf "  ${R}✗${NC} %s\n" "$label"
        return 1
    fi
}

# --- commands ---------------------------------------------------------------

cmd_check() {
    printf "\n${BOLD}Dependency check${NC}\n"
    check_one "Node.js"           command -v node
    command -v node >/dev/null 2>&1 && printf "      %s\n" "$(node --version)"
    check_one "npm"               command -v npm
    check_one "Crawler script"    test -f "$CRAWLER"
    check_one "package.json"      test -f "$SCRIPT_DIR/package.json"
    check_one "Playwright module" test -d "$SCRIPT_DIR/node_modules/playwright"
    check_one "Chromium browser"  bash -c '[ -d "$HOME/.cache/ms-playwright" ] || [ -d "$HOME/Library/Caches/ms-playwright" ]'
    printf "\n"
}

cmd_install() {
    printf "\n${BOLD}Install${NC}\n"
    if ! command -v node >/dev/null 2>&1; then
        printf "${R}Node.js is not installed.${NC}\n"
        printf "  Ubuntu/Debian:  sudo apt install nodejs npm\n"
        printf "  macOS (brew):   brew install node\n"
        printf "  Or download:    https://nodejs.org\n\n"
        return 1
    fi
    cd "$SCRIPT_DIR" || return 1
    [ -f package.json ] || { printf "→ npm init\n"; npm init -y >/dev/null; }
    printf "→ npm install playwright\n"
    npm install playwright || return 1
    printf "→ npx playwright install chromium\n"
    npx playwright install chromium || return 1
    printf "\n${G}Install complete.${NC}\n\n"
}

cmd_launch() {
    printf "\n${BOLD}Launch route-shot${NC}\n"
    if [ ! -f "$CRAWLER" ]; then
        printf "${R}Missing:${NC} %s\n\n" "$CRAWLER"
        return 1
    fi
    if [ ! -d "$SCRIPT_DIR/node_modules/playwright" ]; then
        printf "${Y}Playwright not installed. Run option 2 first.${NC}\n\n"
        return 1
    fi
    read -r -p "  Start URL [$DEFAULT_URL]: " url
    url="${url:-$DEFAULT_URL}"
    printf "%s" "$url" > "$LAST_URL_FILE"
    DEFAULT_URL="$url"
    printf "${B}→ Crawling %s${NC}\n\n" "$url"
    cd "$SCRIPT_DIR" || return 1
    node "$CRAWLER" "$url"
    printf "\n"
}

cmd_import() {
    printf "\n${BOLD}Import DevTools Recorder JSON${NC}\n"
    read -r -p "  Recording file (.json): " rec
    [ -f "$rec" ] || { printf "${R}Not found:${NC} %s\n\n" "$rec"; return 1; }
    read -r -p "  App name (optional): " name
    printf "  Map recording to:\n"
    printf "    1) preSteps  (setup/login flow, runs once)\n"
    printf "    2) clicks    (each click = one variant screenshot)\n"
    read -r -p "  Choice [2]: " mode
    read -r -p "  Merge into apps.json? [Y/n]: " ans
    cd "$SCRIPT_DIR" || return 1
    local merge_args=""
    case "$ans" in n|N|no|NO) merge_args="" ;; *) merge_args="--merge apps.json" ;; esac
    local name_args=""
    [ -n "$name" ] && name_args="--name $name"
    local mode_args="--as-clicks"
    case "$mode" in 1) mode_args="" ;; esac
    node "$CRAWLER" --import-recording "$rec" $name_args $mode_args $merge_args
    printf "\n"
}

cmd_batch() {
    printf "\n${BOLD}Batch run${NC}\n"
    local default_cfg="$SCRIPT_DIR/apps.json"
    [ -f "$default_cfg" ] || default_cfg="$SCRIPT_DIR/apps.example.json"
    read -r -p "  Config file [$default_cfg]: " cfg
    cfg="${cfg:-$default_cfg}"
    if [ ! -f "$cfg" ]; then
        printf "${R}Not found:${NC} %s\n\n" "$cfg"
        return 1
    fi
    cd "$SCRIPT_DIR" || return 1
    node "$CRAWLER" --batch "$cfg"
    printf "\n"
}

cmd_open() {
    if [ ! -d "$OUTPUT_DIR" ]; then
        printf "\n${Y}No screenshots folder yet.${NC}\n\n"
        return 0
    fi
    if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$OUTPUT_DIR" >/dev/null 2>&1 &
        printf "\n→ Opened %s\n\n" "$OUTPUT_DIR"
    elif command -v open >/dev/null 2>&1; then
        open "$OUTPUT_DIR"
        printf "\n→ Opened %s\n\n" "$OUTPUT_DIR"
    else
        printf "\nOpen manually: %s\n\n" "$OUTPUT_DIR"
    fi
}

cmd_server() {
    if [ ! -d "$OUTPUT_DIR" ]; then
        printf "\n${Y}No screenshots folder yet. Run option 3 first.${NC}\n\n"
        return 0
    fi
    if [ -f "$SERVER_PID_FILE" ] && kill -0 "$(cat "$SERVER_PID_FILE")" 2>/dev/null; then
        printf "\n${Y}Server already running (pid $(cat "$SERVER_PID_FILE")) on port %s.${NC}\n\n" "$SERVER_PORT"
        return 0
    fi
    if command -v python3 >/dev/null 2>&1; then
        ( cd "$OUTPUT_DIR" && nohup python3 -m http.server "$SERVER_PORT" >/dev/null 2>&1 & echo $! > "$SERVER_PID_FILE" )
    elif command -v python >/dev/null 2>&1; then
        ( cd "$OUTPUT_DIR" && nohup python -m http.server "$SERVER_PORT" >/dev/null 2>&1 & echo $! > "$SERVER_PID_FILE" )
    elif command -v npx >/dev/null 2>&1; then
        ( cd "$OUTPUT_DIR" && nohup npx --yes serve -l "$SERVER_PORT" . >/dev/null 2>&1 & echo $! > "$SERVER_PID_FILE" )
    else
        printf "\n${R}Need python3 or npx to start a server.${NC}\n\n"
        return 1
    fi
    sleep 1
    printf "\n${G}→ Serving %s at http://localhost:%s${NC}\n\n" "$OUTPUT_DIR" "$SERVER_PORT"
}

cmd_open_web() {
    local url="http://localhost:$SERVER_PORT"
    if [ ! -f "$SERVER_PID_FILE" ] || ! kill -0 "$(cat "$SERVER_PID_FILE" 2>/dev/null)" 2>/dev/null; then
        printf "\n${Y}Server not running — starting it.${NC}\n"
        cmd_server || return 1
    fi
    if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$url" >/dev/null 2>&1 &
    elif command -v open >/dev/null 2>&1; then
        open "$url"
    elif command -v start >/dev/null 2>&1; then
        start "$url"
    else
        printf "Open manually: %s\n\n" "$url"
        return 0
    fi
    printf "→ Opened %s\n\n" "$url"
}

cmd_dashboard() {
    printf "\n${BOLD}Launch web dashboard${NC}\n"
    if [ ! -f "$SCRIPT_DIR/server.js" ]; then
        printf "${R}Missing:${NC} %s/server.js\n\n" "$SCRIPT_DIR"
        return 1
    fi
    local port=8080
    read -r -p "  Port [$port]: " p
    port="${p:-$port}"

    # if something is already on this port, reuse it
    if curl -s -m 1 "http://localhost:$port/api/status" >/dev/null 2>&1; then
        printf "${Y}Dashboard already running on port %s.${NC}\n" "$port"
    else
        cd "$SCRIPT_DIR" || return 1
        node server.js "$port" > "$SCRIPT_DIR/.dashboard.log" 2>&1 &
        local pid=$!
        echo "$pid" > "$SCRIPT_DIR/.dashboard.pid"
        disown "$pid" 2>/dev/null || true
        # wait up to 4 seconds for the server to start listening
        local i=0
        while [ $i -lt 20 ]; do
            if curl -s -m 1 "http://localhost:$port/api/status" >/dev/null 2>&1; then break; fi
            sleep 0.2
            i=$((i + 1))
        done
        if ! curl -s -m 1 "http://localhost:$port/api/status" >/dev/null 2>&1; then
            printf "${R}Dashboard failed to start.${NC} See %s/.dashboard.log\n\n" "$SCRIPT_DIR"
            tail -20 "$SCRIPT_DIR/.dashboard.log" 2>/dev/null
            return 1
        fi
    fi

    local url="http://localhost:$port"
    printf "${G}→ Dashboard at %s${NC}\n\n" "$url"
    if command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 &
    elif command -v open >/dev/null 2>&1; then open "$url"
    elif command -v start >/dev/null 2>&1; then start "" "$url"
    fi
}

cmd_stop_server() {
    if [ -f "$SERVER_PID_FILE" ]; then
        local pid
        pid="$(cat "$SERVER_PID_FILE")"
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null
            printf "\n${G}Server stopped (pid %s).${NC}\n\n" "$pid"
        fi
        rm -f "$SERVER_PID_FILE"
    fi
}

cmd_clean() {
    if [ ! -d "$OUTPUT_DIR" ]; then
        printf "\n${Y}No screenshots folder to clean.${NC}\n\n"
        return 0
    fi
    local count
    count=$(find "$OUTPUT_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')
    printf "\n"
    read -r -p "  Delete $count file(s) in $OUTPUT_DIR? [y/N]: " ans
    case "$ans" in
        y|Y|yes|YES)
            rm -rf "$OUTPUT_DIR"
            printf "${G}Cleaned.${NC}\n\n"
            ;;
        *)
            printf "Cancelled.\n\n"
            ;;
    esac
}

# --- menu -------------------------------------------------------------------

menu() {
    printf "\n"
    printf "${BOLD}╔══════════════════════════════════════╗${NC}\n"
    printf "${BOLD}║             route-shot               ║${NC}\n"
    printf "${BOLD}╚══════════════════════════════════════╝${NC}\n"
    printf "\n"
    printf "  1) Check install\n"
    printf "  2) Install dependencies\n"
    printf "  3) Launch route-shot (single URL)\n"
    printf "  4) Batch run (apps.json)\n"
    printf "  5) Import DevTools Recorder → apps.json\n"
    printf "  6) Launch web dashboard\n"
    printf "  7) Start static server    (http://localhost:%s)\n" "$SERVER_PORT"
    printf "  8) Open in browser\n"
    printf "  9) Stop static server\n"
    printf " 10) Open screenshots folder\n"
    printf " 11) Clean screenshots\n"
    printf " 12) Exit\n"
    printf "\n"
}

trap 'printf "\nInterrupted.\n"; exit 130' INT

while true; do
    menu
    read -r -p "  Choice: " choice
    case "$choice" in
        1) cmd_check ;;
        2) cmd_install ;;
        3) cmd_launch ;;
        4) cmd_batch ;;
        5) cmd_import ;;
        6) cmd_dashboard ;;
        7) cmd_server ;;
        8) cmd_open_web ;;
        9) cmd_stop_server ;;
        10) cmd_open ;;
        11) cmd_clean ;;
        12|q|Q|exit) printf "\nBye.\n"; cmd_stop_server >/dev/null 2>&1; exit 0 ;;
        *) printf "\n${R}Invalid choice.${NC}\n" ;;
    esac
done
