from __future__ import annotations

import json
import logging
import os
import re
import secrets
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from flask import Flask, abort, jsonify, redirect, render_template, request
from flask_socketio import SocketIO, emit, join_room, leave_room
from werkzeug.exceptions import HTTPException

VERSION = "1.0.0"
BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "data" / "um.db"

log = logging.getLogger("um-web")

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("UM_SECRET_KEY") or secrets.token_hex(32)
app.config["JSON_SORT_KEYS"] = False
socketio = SocketIO(app, async_mode="threading", cors_allowed_origins="*", logger=False,
                    engineio_logger=False)

# ... (full app.py is in the repository)
