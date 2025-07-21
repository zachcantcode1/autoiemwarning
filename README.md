# Tornado Warning Monitor

A Node.js server that monitors the Iowa State Mesonet API for tornado warnings in real-time.

## Features

- 🌪️ **Real-time Monitoring**: Checks for tornado warnings every 2 minutes
- 📊 **REST API**: Provides endpoints to access current and historical tornado warning data
- 🔍 **Filtering**: Specifically filters for entries with `"ps": "Tornado Warning"`
- ⏰ **Time Range Queries**: Supports querying warnings for specific time periods
- 🚨 **Alert Detection**: Identifies PDS (Particularly Dangerous Situation) and Emergency warnings

## API Endpoints

### `GET /`
Returns basic server information and available endpoints.

### `GET /api/tornado-warnings`
Returns current active tornado warnings.

**Response:**
```json
{
  "success": true,
  "count": 2,
  "lastUpdate": "2024-07-17T15:30:00.000Z",
  "warnings": [...]
}
```

### `GET /api/tornado-warnings/range?start=ISO8601&end=ISO8601`
Returns tornado warnings for a specific time range.

**Parameters:**
- `start`: Start time in ISO8601 format (e.g., `2024-05-26T19:00:00Z`)
- `end`: End time in ISO8601 format (e.g., `2024-05-26T21:00:00Z`)

### `GET /api/all-warnings`
Returns all current warnings (not just tornado warnings).

### `GET /health`
Health check endpoint showing server status and uptime.

## Installation

1. Clone or download the project
2. Install dependencies:
   ```bash
   npm install
   ```

## Usage

### Development
```bash
npm run dev
```

### Production
```bash
npm start
```

The server will start on port 3000 by default (or the port specified in the `PORT` environment variable).

## Data Source

This application uses the Iowa State Mesonet Storm-Based Warning (SBW) API:
- **API URL**: `https://mesonet.agron.iastate.edu/geojson/sbw.geojson`
- **Documentation**: https://mesonet.agron.iastate.edu/geojson/sbw.py?help

## Warning Data Structure

Each tornado warning includes:

- **Basic Info**: WFO office, event ID, status, issue/expiration times
- **Geographic Data**: Polygon coordinates defining the warning area
- **Threat Info**: Wind speeds, hail size, tornado indicators
- **Special Flags**: PDS (Particularly Dangerous Situation), Emergency status
- **Links**: Direct links to detailed warning information

## Monitoring Schedule

The server automatically checks for new tornado warnings every 2 minutes. You can modify this interval by changing the cron schedule in `server.js`:

```javascript
// Check every 2 minutes
cron.schedule('*/2 * * * *', monitorTornadoWarnings);

// Check every minute
cron.schedule('*/1 * * * *', monitorTornadoWarnings);

// Check every 5 minutes
cron.schedule('*/5 * * * *', monitorTornadoWarnings);
```

## Environment Variables

- `PORT`: Server port (default: 3000)

## Example Usage

### Check Current Tornado Warnings
```bash
curl http://localhost:3000/api/tornado-warnings
```

### Query Tornado Warnings for a Specific Time Period
```bash
curl "http://localhost:3000/api/tornado-warnings/range?start=2024-05-26T19:00:00Z&end=2024-05-26T21:00:00Z"
```

### Server Health Check
```bash
curl http://localhost:3000/health
```

## Notes

- The API uses GeoJSON format for geographic data
- Times are in UTC format
- The server logs all tornado warning detections to the console
- PDS and Emergency warnings are specially highlighted in logs
