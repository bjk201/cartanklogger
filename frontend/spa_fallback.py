# SPA Fallback Route - muss in app.py integriert werden
# Diese Datei dient als Referenz für die Route-Definition

# In app.py nach den API-Routen folgenden Code einfügen:

@app.route("/app/<path:path>")
def spa_fallback(path):
    """SPA fallback - liefert index.html für alle /app/* Pfade"""
    # Wichtig: API-Endpunkte nicht überschreiben (siehe unten)
    if path.startswith("api/"):
        abort(404)
    
    try:
        with open(os.path.join(os.path.dirname(__file__), "frontend", "index.html"), "r") as f:
            return f.read()
    except FileNotFoundError:
        return "React frontend not found", 404