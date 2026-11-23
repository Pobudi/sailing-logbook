from fastapi import FastAPI, UploadFile, File, HTTPException, Form
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.requests import Request
from fastapi.responses import JSONResponse
import gpxpy
import json
import uuid
import shutil
from pathlib import Path
from datetime import datetime, date
from typing import Optional
import sqlite3

app = FastAPI(title="Sailor's Logbook")

# Mount static files and templates
app.mount("/static", StaticFiles(directory="static"), name="static")
app.mount("/uploads", StaticFiles(directory="uploads"), name="uploads")
templates = Jinja2Templates(directory="templates")

DB_PATH = "data/logbook.db"

# ── Database ──────────────────────────────────────────────────────────────────

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    Path("data").mkdir(exist_ok=True)
    Path("uploads").mkdir(exist_ok=True)
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS voyages (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL,
            date        TEXT NOT NULL,
            boat        TEXT,
            start_port  TEXT,
            end_port    TEXT,
            distance_nm REAL DEFAULT 0,
            duration_h  REAL DEFAULT 0,
            crew        TEXT,
            notes       TEXT,
            gpx_file    TEXT,
            track_json  TEXT,
            created_at  TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS stats (
            id              INTEGER PRIMARY KEY,
            total_nm        REAL DEFAULT 0,
            total_hours     REAL DEFAULT 0,
            last_updated    TEXT
        );
    """)
    # Ensure a stats row exists
    conn.execute("INSERT OR IGNORE INTO stats (id) VALUES (1)")
    conn.commit()
    conn.close()

# ── GPX Parsing ───────────────────────────────────────────────────────────────

def parse_gpx(file_path: str) -> dict:
    """Parse GPX file and return track points + computed stats.
    Handles both <trk> tracks and <rte> routes (common in chart plotters).
    """
    import math

    with open(file_path, "r", encoding="utf-8") as f:
        gpx = gpxpy.parse(f)

    points = []

    # 1. Try tracks first (<trk> — recorded GPS logs)
    for track in gpx.tracks:
        for segment in track.segments:
            for pt in segment.points:
                points.append({
                    "lat": pt.latitude,
                    "lng": pt.longitude,
                    "ele": pt.elevation,
                    "time": pt.time.isoformat() if pt.time else None,
                })

    # 2. Fall back to routes (<rte> — planned routes, common in Navionics/OpenCPN)
    if not points:
        for route in gpx.routes:
            for pt in route.points:
                points.append({
                    "lat": pt.latitude,
                    "lng": pt.longitude,
                    "ele": pt.elevation,
                    "time": pt.time.isoformat() if pt.time else None,
                })

    # 3. Last resort: use waypoints as a path
    if not points and gpx.waypoints:
        for wp in gpx.waypoints:
            points.append({
                "lat": wp.latitude,
                "lng": wp.longitude,
                "ele": wp.elevation,
                "time": None,
            })

    # Standalone waypoints (harbour marks, POIs)
    waypoints = []
    for wp in gpx.waypoints:
        waypoints.append({
            "lat": wp.latitude,
            "lng": wp.longitude,
            "name": wp.name or "",
            "desc": wp.description or "",
        })

    # Distance: tracks → routes → manual haversine
    distance_m = gpx.length_2d() or 0
    if distance_m == 0:
        for route in gpx.routes:
            distance_m += route.length() or 0
    if distance_m == 0 and len(points) >= 2:
        def haversine(p1, p2):
            R = 6371000
            lat1, lon1 = math.radians(p1["lat"]), math.radians(p1["lng"])
            lat2, lon2 = math.radians(p2["lat"]), math.radians(p2["lng"])
            dlat, dlon = lat2 - lat1, lon2 - lon1
            a = math.sin(dlat/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(dlon/2)**2
            return R * 2 * math.asin(math.sqrt(a))
        distance_m = sum(haversine(points[i], points[i+1]) for i in range(len(points)-1))

    distance_nm = distance_m / 1852

    duration_h = 0
    bounds = gpx.get_time_bounds()
    if bounds.start_time and bounds.end_time:
        delta = bounds.end_time - bounds.start_time
        duration_h = delta.total_seconds() / 3600

    gpx_bounds = gpx.get_bounds()
    bbox = None
    if gpx_bounds:
        bbox = {
            "min_lat": gpx_bounds.min_latitude,
            "max_lat": gpx_bounds.max_latitude,
            "min_lng": gpx_bounds.min_longitude,
            "max_lng": gpx_bounds.max_longitude,
        }

    print(f"[GPX] {len(points)} points | {len(gpx.tracks)} tracks | "
          f"{len(gpx.routes)} routes | {distance_nm:.2f} NM")

    return {
        "points": points,
        "waypoints": waypoints,
        "distance_nm": round(distance_nm, 2),
        "duration_h": round(duration_h, 2),
        "bbox": bbox,
    }

# ── Routes ────────────────────────────────────────────────────────────────────

@app.on_event("startup")
def startup():
    init_db()

@app.get("/")
def index(request: Request):
    return templates.TemplateResponse(request, "index.html")

@app.get("/api/voyages")
def list_voyages():
    conn = get_db()
    rows = conn.execute(
        "SELECT id, title, date, boat, start_port, end_port, distance_nm, duration_h, gpx_file "
        "FROM voyages ORDER BY date DESC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]

@app.get("/api/voyages/{voyage_id}")
def get_voyage(voyage_id: str):
    conn = get_db()
    row = conn.execute("SELECT * FROM voyages WHERE id=?", (voyage_id,)).fetchone()
    conn.close()
    if not row:
        raise HTTPException(404, "Voyage not found")
    data = dict(row)
    if data.get("track_json"):
        data["track"] = json.loads(data["track_json"])
    del data["track_json"]
    return data

@app.post("/api/voyages")
async def create_voyage(
    title: str = Form(...),
    date: str = Form(...),
    boat: str = Form(""),
    start_port: str = Form(""),
    end_port: str = Form(""),
    distance_nm: float = Form(0),
    duration_h: float = Form(0),
    crew: str = Form(""),
    notes: str = Form(""),
    gpx_file: Optional[UploadFile] = File(None),
):
    voyage_id = str(uuid.uuid4())
    gpx_path = None
    track_json = None

    if gpx_file and gpx_file.filename:
        ext = Path(gpx_file.filename).suffix.lower() or ".gpx"
        gpx_path = f"uploads/{voyage_id}{ext}"

        # Await full read to avoid async spooled-file issues
        contents = await gpx_file.read()
        with open(gpx_path, "wb") as f:
            f.write(contents)

        try:
            parsed = parse_gpx(gpx_path)
            track_json = json.dumps(parsed)
            # Only use GPX-computed values if the user left the fields blank (zero)
            if distance_nm == 0 and parsed["distance_nm"] > 0:
                distance_nm = parsed["distance_nm"]
            if duration_h == 0 and parsed["duration_h"] > 0:
                duration_h = parsed["duration_h"]
        except Exception as e:
            print(f"[GPX] Parse error for {gpx_file.filename}: {e}")

    conn = get_db()
    conn.execute(
        """INSERT INTO voyages
           (id, title, date, boat, start_port, end_port, distance_nm, duration_h,
            crew, notes, gpx_file, track_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (voyage_id, title, date, boat, start_port, end_port,
         distance_nm, duration_h, crew, notes, gpx_path, track_json),
    )
    # Update cumulative stats
    conn.execute(
        "UPDATE stats SET total_nm = total_nm + ?, total_hours = total_hours + ?, last_updated = datetime('now') WHERE id=1",
        (distance_nm, duration_h),
    )
    conn.commit()
    conn.close()
    return {"id": voyage_id, "message": "Voyage logged!"}

@app.delete("/api/voyages/{voyage_id}")
def delete_voyage(voyage_id: str):
    conn = get_db()
    row = conn.execute("SELECT distance_nm, duration_h, gpx_file FROM voyages WHERE id=?", (voyage_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Not found")
    if row["gpx_file"] and Path(row["gpx_file"]).exists():
        Path(row["gpx_file"]).unlink()
    conn.execute("DELETE FROM voyages WHERE id=?", (voyage_id,))
    conn.execute(
        "UPDATE stats SET total_nm = MAX(0, total_nm - ?), total_hours = MAX(0, total_hours - ?) WHERE id=1",
        (row["distance_nm"], row["duration_h"]),
    )
    conn.commit()
    conn.close()
    return {"message": "Deleted"}

@app.get("/api/stats")
def get_stats():
    conn = get_db()
    stats = dict(conn.execute("SELECT * FROM stats WHERE id=1").fetchone())
    voyage_count = conn.execute("SELECT COUNT(*) FROM voyages").fetchone()[0]
    conn.close()
    stats["voyage_count"] = voyage_count
    return stats