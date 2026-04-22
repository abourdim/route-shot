#!/usr/bin/env bash
# menu.sh — interactive wrapper for route-shot
# Usage: chmod +x menu.sh && ./menu.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRAWLER="$SCRIPT_DIR/src/route-shot.js"
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

# Open a URL in Chrome if installed (Windows/macOS/Linux), otherwise fall
# back to the OS default browser. Override with $ROUTE_SHOT_BROWSER (path to
# any browser executable).
open_url() {
    local url="$1"
    # 1. Explicit override
    if [ -n "$ROUTE_SHOT_BROWSER" ] && [ -x "$ROUTE_SHOT_BROWSER" ]; then
        printf "${B}→ Launching (ROUTE_SHOT_BROWSER): %s${NC}\n" "$ROUTE_SHOT_BROWSER"
        "$ROUTE_SHOT_BROWSER" "$url" >/dev/null 2>&1 &
        return
    fi
    # 2. Windows: try 'start chrome' first — works via URL association, survives
    #    path quirks and spaces, respects existing Chrome profile. Falls back to
    #    explicit chrome.exe paths if that fails.
    if command -v cmd.exe >/dev/null 2>&1 || [ -n "$WINDIR" ]; then
        # convert MSYS /c/... path if any, pass the raw URL
        if cmd.exe /c "start chrome \"$url\"" 2>/dev/null; then
            printf "${B}→ Launched Chrome via 'start chrome'${NC}\n"
            return
        fi
        for p in "/c/Program Files/Google/Chrome/Application/chrome.exe" \
                 "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
                 "$LOCALAPPDATA/Google/Chrome/Application/chrome.exe"; do
            if [ -f "$p" ]; then
                printf "${B}→ Launching Chrome: %s${NC}\n" "$p"
                "$p" "$url" >/dev/null 2>&1 &
                return
            fi
        done
    fi
    # 3. macOS Chrome
    if [ -d "/Applications/Google Chrome.app" ]; then
        printf "${B}→ Launching Chrome (macOS)${NC}\n"
        open -a "Google Chrome" "$url"
        return
    fi
    # 4. Linux Chrome / Chromium
    for cmd in google-chrome google-chrome-stable chrome chromium chromium-browser; do
        if command -v "$cmd" >/dev/null 2>&1; then
            printf "${B}→ Launching %s${NC}\n" "$cmd"
            "$cmd" "$url" >/dev/null 2>&1 &
            return
        fi
    done
    # 5. OS default browser
    if   command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 &
    elif command -v open     >/dev/null 2>&1; then open "$url"
    elif command -v start    >/dev/null 2>&1; then start "" "$url"
    else printf "${Y}No browser auto-open available. Visit manually: %s${NC}\n" "$url"
    fi
}


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
    local mode_flag=""
    case "$mode" in 1) mode_flag="" ;; *) mode_flag="--as-clicks" ;; esac
    # Build argv as an array so values with spaces / shell metachars stay quoted.
    local args=(--import-recording "$rec")
    [ -n "$name" ] && args+=(--name "$name")
    [ -n "$mode_flag" ] && args+=("$mode_flag")
    case "$ans" in n|N|no|NO) ;; *) args+=(--merge apps.json) ;; esac
    node "$CRAWLER" "${args[@]}"
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
    open_url "$url"
    printf "→ Opened %s\n\n" "$url"
}

cmd_dashboard() {
    printf "\n${BOLD}Launch web dashboard${NC}\n"
    if [ ! -f "$SCRIPT_DIR/src/server.js" ]; then
        printf "${R}Missing:${NC} %s/src/server.js\n\n" "$SCRIPT_DIR"
        return 1
    fi
    # Default 8080, override with $ROUTE_SHOT_PORT env var. No prompt — server
    # auto-falls-back to next free port if 8080 is busy, so no user input needed.
    local port="${ROUTE_SHOT_PORT:-8080}"

    # if something is already on this port, reuse it
    if curl -s -m 1 "http://localhost:$port/api/status" >/dev/null 2>&1; then
        printf "${Y}Dashboard already running on port %s.${NC}\n" "$port"
    else
        cd "$SCRIPT_DIR" || return 1
        node src/server.js "$port" > "$SCRIPT_DIR/.dashboard.log" 2>&1 &
        local pid=$!
        echo "$pid" > "$SCRIPT_DIR/.dashboard.pid"
        disown "$pid" 2>/dev/null || true
        # wait up to 6 seconds for the server to print its chosen port
        local i=0 chosen=""
        while [ $i -lt 30 ]; do
            chosen=$(grep -oE 'http://localhost:[0-9]+' "$SCRIPT_DIR/.dashboard.log" 2>/dev/null | tail -1 | sed 's|.*:||')
            [ -n "$chosen" ] && break
            sleep 0.2
            i=$((i + 1))
        done
        if [ -z "$chosen" ]; then
            printf "${R}Dashboard failed to start.${NC} See %s/.dashboard.log\n\n" "$SCRIPT_DIR"
            tail -20 "$SCRIPT_DIR/.dashboard.log" 2>/dev/null
            return 1
        fi
        if [ "$chosen" != "$port" ]; then
            printf "${Y}Port %s was busy — using %s instead.${NC}\n" "$port" "$chosen"
            port="$chosen"
        fi
    fi

    local url="http://localhost:$port"
    printf "${G}→ Dashboard at %s${NC}\n\n" "$url"
    open_url "$url"
}

cmd_dashboard_stop() {
    local pid_file="$SCRIPT_DIR/.dashboard.pid"
    local stopped=0
    # 1. PID file
    if [ -f "$pid_file" ]; then
        local pid; pid="$(cat "$pid_file")"
        if [ -n "$pid" ]; then
            taskkill //F //PID "$pid" >/dev/null 2>&1 || kill "$pid" 2>/dev/null && stopped=1
        fi
        rm -f "$pid_file"
    fi
    # 2. Anything still listening on a likely dashboard port (8080..8099)
    for port in 8080 8081 8082 8083 8084 8085; do
        local listener
        listener=$(netstat -ano 2>/dev/null | grep -E "[: ]$port +.*LISTENING" | awk '{print $NF}' | head -1)
        if [ -n "$listener" ]; then
            taskkill //F //PID "$listener" >/dev/null 2>&1 && stopped=1
        fi
    done
    if [ "$stopped" = "1" ]; then
        printf "\n${G}Dashboard stopped.${NC}\n\n"
    else
        printf "\n${Y}No running dashboard found.${NC}\n\n"
    fi
}

cmd_dashboard_restart() {
    cmd_dashboard_stop >/dev/null 2>&1
    sleep 0.5
    cmd_dashboard
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
    printf "  7) Restart web dashboard  (kill + relaunch, picks up code changes)\n"
    printf "  8) Stop web dashboard\n"
    printf "  9) Start static server    (http://localhost:%s)\n" "$SERVER_PORT"
    printf " 10) Open in browser\n"
    printf " 11) Stop static server\n"
    printf " 12) Open screenshots folder\n"
    printf " 13) Clean screenshots\n"
    printf " 14) Exit\n"
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
        7) cmd_dashboard_restart ;;
        8) cmd_dashboard_stop ;;
        9) cmd_server ;;
        10) cmd_open_web ;;
        11) cmd_stop_server ;;
        12) cmd_open ;;
        13) cmd_clean ;;
        14|q|Q|exit) printf "\nBye.\n"; cmd_stop_server >/dev/null 2>&1; cmd_dashboard_stop >/dev/null 2>&1; exit 0 ;;
        *) printf "\n${R}Invalid choice.${NC}\n" ;;
    esac
done
