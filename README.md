# ⚓ Sailor's Logbook

A digital sailing logbook web app built with Python (FastAPI) and Leaflet.js.

## Features
- 🗺️ Interactive nautical map with OpenSeaMap overlay
- 📁 Upload GPX tracks — auto-computes distance & duration
- ✍️ Manual entry for hours, miles, ports, crew, notes
- 📊 Cumulative stats: total NM, hours, voyages
- 🌊 Multiple colour-coded tracks on one map

## Setup

```bash
# 1. Create a virtual environment
python -m venv venv
source venv/bin/activate      # Windows: venv\Scripts\activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Run the app
uvicorn app:app --reload --port 8000
```

Then open http://localhost:8000 in your browser.

## Project Structure
```
sailor-logbook/
├── app.py              ← FastAPI backend + GPX parsing
├── requirements.txt
├── templates/
│   └── index.html      ← Main page
├── static/
│   ├── css/style.css   ← Nautical dark theme
│   └── js/app.js       ← Map logic, API calls
├── data/
│   └── logbook.db      ← SQLite database (auto-created)
└── uploads/            ← Stored GPX files (auto-created)
```

## GPX Sources
You can get GPX tracks from:
- **Garmin Connect** → export activity as GPX
- **Navionics** → export route
- **OpenCPN** → export track
- **Strava** (if you use it for sailing)
- **Komoot**, **Windy** etc.

## Extending
- Add weather data (import from a GRIB file or API)
- Photo attachments per voyage
- Export to PDF logbook
- User authentication for multiple sailors
- Deploy to a VPS with `gunicorn` + `nginx`
