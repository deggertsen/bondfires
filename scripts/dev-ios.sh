#!/bin/bash

# Bondfires Development Environment - iOS + Convex
# This script uses tmux to run both the Convex dev server and the Expo iOS app

SESSION_NAME="bondfires-dev"

# Check if tmux is installed
if ! command -v tmux &> /dev/null; then
    echo "❌ tmux is not installed. Please install it first:"
    echo "   macOS: brew install tmux"
    echo "   Linux: sudo apt install tmux"
    exit 1
fi

# Kill existing session if it exists
tmux kill-session -t $SESSION_NAME 2>/dev/null

# Get the project root directory
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Create a new tmux session with the first window running Convex
tmux new-session -d -s $SESSION_NAME -n "dev" -c "$PROJECT_ROOT"

# Split the window horizontally (top/bottom)
tmux split-window -v -t $SESSION_NAME -c "$PROJECT_ROOT"

# Run Convex dev server in the top pane
tmux send-keys -t $SESSION_NAME:0.0 "yarn dlx convex dev" C-m

# Run Expo iOS in the bottom pane (builds native app if needed, then starts)
tmux send-keys -t $SESSION_NAME:0.1 "cd apps/mobile && yarn ios" C-m

# Select the bottom pane (Expo) as the active one
tmux select-pane -t $SESSION_NAME:0.1

# Attach to the session
tmux attach-session -t $SESSION_NAME
