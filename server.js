const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const FormData = require('form-data');
const fs = require('fs');
const xml2js = require('xml2js');

const app = express();
const PORT = process.env.PORT || 3001;

// Store tornado warnings data
let tornadoWarnings = [];
let lastUpdate = null;
let lastMdIds = new Set();

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Iowa Mesonet API configuration
const API_BASE_URL = 'https://mesonet.agron.iastate.edu/geojson/sbw.geojson';

/**
 * Get current UTC timestamp in ISO8601 format
 * The API expects UTC time with 'Z' suffix
 */
function getCurrentUTCTimestamp() {
    const now = new Date();
    const utcTimestamp = now.toISOString();
    console.log(`Current UTC time: ${utcTimestamp} (Local time: ${now.toLocaleString()})`);
    return utcTimestamp;
}

/**
 * Fetch current active warnings from the API
 * Uses current UTC timestamp to get active warnings
 */
async function fetchCurrentWarnings() {
    try {
        const currentTime = getCurrentUTCTimestamp();
        const url = `${API_BASE_URL}?ts=${currentTime}`;
        
        console.log(`Fetching data from: ${url}`);
        const response = await axios.get(url);
        
        return response.data;
    } catch (error) {
        console.error('Error fetching current warnings:', error.message);
        return null;
    }
}

/**
 * Validate and format timestamp to ISO8601 UTC format
 * @param {string} timestamp - Input timestamp (can be various formats)
 * @returns {string} - ISO8601 UTC formatted timestamp
 */
function validateAndFormatTimestamp(timestamp) {
    let date;
    
    // Try to parse the timestamp
    if (timestamp.includes('T') && timestamp.includes('Z')) {
        // Already in ISO8601 UTC format
        date = new Date(timestamp);
    } else if (timestamp.includes('T') && !timestamp.includes('Z')) {
        // ISO8601 without timezone, assume UTC
        date = new Date(timestamp + 'Z');
    } else if (timestamp.match(/^\d{4}-\d{2}-\d{2}$/)) {
        // Date only (YYYY-MM-DD), assume start of day UTC
        date = new Date(timestamp + 'T00:00:00Z');
    } else {
        // Try to parse as-is
        date = new Date(timestamp);
    }
    
    if (isNaN(date.getTime())) {
        throw new Error(`Invalid timestamp format: ${timestamp}`);
    }
    
    const utcTimestamp = date.toISOString();
    console.log(`Formatted timestamp: ${timestamp} -> ${utcTimestamp}`);
    return utcTimestamp;
}

/**
 * Fetch warnings for a specific time range
 * @param {string} startTime - Start time (various formats accepted)
 * @param {string} endTime - End time (various formats accepted)
 */
async function fetchWarningsForTimeRange(startTime, endTime) {
    try {
        const formattedStartTime = validateAndFormatTimestamp(startTime);
        const formattedEndTime = validateAndFormatTimestamp(endTime);
        
        const url = `${API_BASE_URL}?sts=${formattedStartTime}&ets=${formattedEndTime}`;
        
        console.log(`Fetching data from: ${url}`);
        const response = await axios.get(url);
        
        return response.data;
    } catch (error) {
        console.error('Error fetching warnings for time range:', error.message);
        return null;
    }
}

/**
 * Parse GeoJSON data and extract tornado warnings
 * @param {Object} geoJsonData - The GeoJSON response from the API
 */
function parseTornadoWarnings(geoJsonData) {
    if (!geoJsonData || !geoJsonData.features) {
        console.log('No data or features found');
        return [];
    }

    // Helper to get bounding box from GeoJSON geometry, with margin
    function getBoundingBox(geometry, margin = 0.2) {
        if (!geometry || !geometry.coordinates) return null;
        let coords = [];
        if (geometry.type === 'Polygon') {
            coords = geometry.coordinates.flat();
        } else if (geometry.type === 'MultiPolygon') {
            coords = geometry.coordinates.flat(2);
        } else {
            return null;
        }
        let lats = coords.map(c => c[1]);
        let lons = coords.map(c => c[0]);
        let xmin = Math.min(...lons) - margin;
        let xmax = Math.max(...lons) + margin;
        let ymin = Math.min(...lats) - margin;
        let ymax = Math.max(...lats) + margin;
        return { xmin, ymin, xmax, ymax };
    }

    // Helper to format timestamp for RadMap API (YYYYMMDDHHMM)
    function formatTimestampForRadMap(ts) {
        if (!ts) return '';
        // Accepts ISO8601 string
        const d = new Date(ts);
        if (isNaN(d.getTime())) return '';
        const pad = n => n.toString().padStart(2, '0');
        return (
            d.getUTCFullYear().toString() +
            pad(d.getUTCMonth() + 1) +
            pad(d.getUTCDate()) +
            pad(d.getUTCHours()) +
            pad(d.getUTCMinutes())
        );
    }

    const tornadoWarnings = geoJsonData.features.filter(feature => {
        const properties = feature.properties;
        return properties && properties.ps === "Tornado Warning";
    });

    console.log(`Found ${tornadoWarnings.length} tornado warnings out of ${geoJsonData.features.length} total warnings`);

    return tornadoWarnings.map(feature => {
        const bbox = getBoundingBox(feature.geometry, 0.2); // Add margin to zoom out
        const issued = feature.properties.issue;
        let radmapUrl = null;
        // Use large NEXRAD radar again
        if (bbox && issued) {
            const ts = formatTimestampForRadMap(issued);
            radmapUrl = `https://mesonet.agron.iastate.edu/GIS/radmap.php?layers[]=nexrad&layers[]=sbw&layers[]=places&layers[]=interstates&layers[]=uscounties&bbox=${bbox.xmin},${bbox.ymin},${bbox.xmax},${bbox.ymax}&width=800&height=600&ts=${ts}&title=Tornado%20Warning`;
            console.log(`RadMap URL for warning ${feature.id}: ${radmapUrl}`);
        } else {
            console.log(`No bbox or issued time for warning ${feature.id}`);
        }
        // Add NWS text URL using product_id
        let nwstextUrl = null;
        if (feature.properties.product_id) {
            nwstextUrl = `https://mesonet.agron.iastate.edu/json/nwstext.py?product_id=${feature.properties.product_id}`;
        }
        // Generate new plot image URL from warning properties
        let plotImageUrl = null;
        if (feature.properties.wfo && feature.properties.year && feature.properties.phenomena && feature.properties.significance && feature.properties.eventid) {
            plotImageUrl = `https://mesonet.agron.iastate.edu/plotting/auto/plot/208/network:WFO::wfo:${feature.properties.wfo}::year:${feature.properties.year}::phenomenav:${feature.properties.phenomena}::significancev:${feature.properties.significance}::etn:${feature.properties.eventid}::opt:single::n:auto::_r:88::dpi:200.png`;
        }
        return {
            id: feature.id,
            properties: feature.properties,
            geometry: feature.geometry,
            // Extract key information for easy access
            wfo: feature.properties.wfo,
            eventid: feature.properties.eventid,
            status: feature.properties.status,
            issued: feature.properties.issue,
            expires: feature.properties.expire_utc,
            polygonBegin: feature.properties.polygon_begin,
            polygonEnd: feature.properties.polygon_end,
            windtag: feature.properties.windtag,
            hailtag: feature.properties.hailtag,
            tornadotag: feature.properties.tornadotag,
            isPDS: feature.properties.is_pds,
            isEmergency: feature.properties.is_emergency,
            productSignature: feature.properties.product_signature,
            href: feature.properties.href,
            radmapImageUrl: radmapUrl,
            plotImageUrl: plotImageUrl,
            nwstextUrl: nwstextUrl
        };
    });
}

/**
 * Monitor for tornado warnings
 */
async function monitorTornadoWarnings() {
    console.log('Checking for tornado warnings...');
    
    // Get current active warnings
    const currentData = await fetchCurrentWarnings();
    
    if (currentData) {
        const newTornadoWarnings = parseTornadoWarnings(currentData);
        // Find warnings that are new (not in tornadoWarnings by id)
        const prevIds = new Set(tornadoWarnings.map(w => w.id));
        const trulyNew = newTornadoWarnings.filter(w => !prevIds.has(w.id));
        if (newTornadoWarnings.length > 0) {
            console.log(`🌪️  TORNADO WARNINGS DETECTED: ${newTornadoWarnings.length} active warnings`);
            newTornadoWarnings.forEach(warning => {
                console.log(`- ${warning.wfo} Event ${warning.eventid}: ${warning.status} (Expires: ${warning.expires})`);
                if (warning.isPDS) console.log('  ⚠️  PDS (Particularly Dangerous Situation)');
                if (warning.isEmergency) console.log('  🚨 EMERGENCY');
            });
        } else {
            console.log('✅ No active tornado warnings found');
        }
        // For each truly new warning, send to Discord webhook
        for (const warning of trulyNew) {
            try {
                // Fetch raw text
                let textData = '';
                if (warning.nwstextUrl) {
                    const textResp = await axios.get(warning.nwstextUrl);
                    if (textResp.data && Array.isArray(textResp.data.products) && textResp.data.products[0] && textResp.data.products[0].data) {
                        textData = textResp.data.products[0].data;
                    }
                }
                // Download plot image instead of radmap image
                let imageBuffer = null;
                let imageFilename = 'plot.png';
                if (warning.plotImageUrl) {
                    const imageResp = await axios.get(warning.plotImageUrl, { responseType: 'arraybuffer' });
                    imageBuffer = Buffer.from(imageResp.data, 'binary');
                }
                // Prepare form data for Discord webhook
                const form = new FormData();
                form.append('content', `**Tornado Warning**\nWFO: ${warning.wfo}\nEvent ID: ${warning.eventid}\nStatus: ${warning.status}\nExpires: ${warning.expires}\n\n**Raw Text:**\n\u200B\n${textData.substring(0,1800)}${textData.length>1800?'...':''}`);
                if (imageBuffer) {
                    form.append('file', imageBuffer, imageFilename);
                }
                await axios.post(
                    'https://hook.us2.make.com/encxha5954hndv65p98is9prvx53qtua',
                    form,
                    { headers: form.getHeaders() }
                );
                console.log(`Sent new warning ${warning.id} to Discord webhook.`);
            } catch (err) {
                console.error(`Failed to send warning ${warning.id} to Discord webhook:`, err.message);
            }
        }
        tornadoWarnings = newTornadoWarnings;
        lastUpdate = new Date().toISOString();
    }
}

/**
 * Monitor for mesoscale discussions
 */
async function monitorMesoscaleDiscussions() {
    try {
        const rssUrl = 'https://www.spc.noaa.gov/products/spcmdrss.xml';
        const response = await axios.get(rssUrl);
        const xml = response.data;
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(xml);
        const items = result.rss.channel[0].item || [];
        for (const item of items) {
            const guid = item.guid[0]._ || item.link[0];
            if (lastMdIds.has(guid)) continue;
            lastMdIds.add(guid);
            // Extract image URL from description
            let imageUrl = null;
            let textContent = '';
            if (item.description && item.description[0]) {
                const desc = item.description[0];
                const imgMatch = desc.match(/<img src="([^"]+)"/);
                if (imgMatch) imageUrl = imgMatch[1];
                // Remove HTML tags for text
                textContent = desc.replace(/<[^>]+>/g, '').trim();
            }
            // Prepare form data for Discord webhook
            const form = new FormData();
            form.append('content', `**Mesoscale Discussion**\n${item.title[0]}\n\n${textContent}`);
            if (imageUrl) {
                const imageResp = await axios.get(imageUrl, { responseType: 'arraybuffer' });
                form.append('file', Buffer.from(imageResp.data, 'binary'), 'md.png');
            }
            await axios.post(
                'https://hook.us2.make.com/2lfo732u8mwrpaabjdesea44s8iccn0c',
                form,
                { headers: form.getHeaders() }
            );
            console.log(`Sent new MD ${guid} to Discord webhook.`);
        }
    } catch (err) {
        console.error('Error monitoring mesoscale discussions:', err.message);
    }
}

// Routes
/**
 * Simulate historical tornado warnings as new and send to webhook
 * POST /api/simulate-tornado-warnings?start=ISO8601&end=ISO8601
 */
app.post('/api/simulate-tornado-warnings', async (req, res) => {
    const { start, end } = req.query;
    if (!start || !end) {
        return res.status(400).json({
            success: false,
            error: 'Both start and end parameters are required (ISO8601 format)'
        });
    }
    try {
        const data = await fetchWarningsForTimeRange(start, end);
        const warnings = data ? parseTornadoWarnings(data) : [];
        let sent = 0, failed = 0;
        for (const warning of warnings) {
            try {
                let textData = '';
                if (warning.nwstextUrl) {
                    const textResp = await axios.get(warning.nwstextUrl);
                    if (textResp.data && Array.isArray(textResp.data.products) && textResp.data.products[0] && textResp.data.products[0].data) {
                        textData = textResp.data.products[0].data;
                    }
                }
                // Download plot image instead of radmap image
                let imageBuffer = null;
                let imageFilename = 'plot.png';
                if (warning.plotImageUrl) {
                    const imageResp = await axios.get(warning.plotImageUrl, { responseType: 'arraybuffer' });
                    imageBuffer = Buffer.from(imageResp.data, 'binary');
                }
                // Prepare form data for Discord webhook
                const form = new FormData();
                form.append('content', `**Tornado Warning**\nWFO: ${warning.wfo}\nEvent ID: ${warning.eventid}\nStatus: ${warning.status}\nExpires: ${warning.expires}\n\n**Raw Text:**\n\u200B\n${textData.substring(0,1800)}${textData.length>1800?'...':''}`);
                if (imageBuffer) {
                    form.append('file', imageBuffer, imageFilename);
                }
                await axios.post(
                    'https://hook.us2.make.com/encxha5954hndv65p98is9prvx53qtua',
                    form,
                    { headers: form.getHeaders() }
                );
                sent++;
            } catch (err) {
                failed++;
                console.error(`Failed to send simulated warning ${warning.id} to webhook:`, err.message);
            }
        }
        res.json({
            success: true,
            sent,
            failed,
            count: warnings.length
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Get current tornado warnings
 */
app.get('/api/tornado-warnings', (req, res) => {
    res.json({
        success: true,
        count: tornadoWarnings.length,
        lastUpdate: lastUpdate,
        warnings: tornadoWarnings
    });
});

/**
 * Get tornado warnings for a specific time range
 */
app.get('/api/tornado-warnings/range', async (req, res) => {
    const { start, end } = req.query;
    
    if (!start || !end) {
        return res.status(400).json({
            success: false,
            error: 'Both start and end parameters are required (ISO8601 format)'
        });
    }
    
    try {
        const data = await fetchWarningsForTimeRange(start, end);
        const warnings = data ? parseTornadoWarnings(data) : [];
        // Log the full warnings array to verify radmapImageUrl presence
        console.log('API response warnings:', JSON.stringify(warnings, null, 2));
        res.json({
            success: true,
            count: warnings.length,
            timeRange: { start, end },
            warnings: warnings
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Get all current warnings (not just tornado warnings)
 */
app.get('/api/all-warnings', async (req, res) => {
    try {
        const data = await fetchCurrentWarnings();
        
        if (!data) {
            return res.status(500).json({
                success: false,
                error: 'Failed to fetch data from API'
            });
        }
        
        res.json({
            success: true,
            count: data.features ? data.features.length : 0,
            lastUpdate: new Date().toISOString(),
            data: data
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        lastUpdate: lastUpdate,
        currentWarnings: tornadoWarnings.length
    });
});

/**
 * Time verification endpoint - shows current time handling
 */
app.get('/api/time', (req, res) => {
    const now = new Date();
    const utcTimestamp = getCurrentUTCTimestamp();
    
    res.json({
        success: true,
        localTime: now.toLocaleString(),
        localTimeISO: now.toISOString(),
        utcTime: utcTimestamp,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        unixTimestamp: now.getTime(),
        note: 'API uses UTC time with Z suffix'
    });
});

/**
 * Root endpoint with basic info
 */
app.get('/', (req, res) => {
    res.json({
        name: 'Tornado Warning Monitor',
        description: 'Monitors Iowa State Mesonet API for tornado warnings',
        endpoints: {
            'GET /api/tornado-warnings': 'Get current tornado warnings',
            'GET /api/tornado-warnings/range?start=ISO8601&end=ISO8601': 'Get tornado warnings for time range',
            'GET /api/all-warnings': 'Get all current warnings',
            'GET /api/time': 'Check current time handling',
            'GET /health': 'Health check'
        },
        lastUpdate: lastUpdate,
        currentTornadoWarnings: tornadoWarnings.length
    });
});

// Schedule monitoring every 10 seconds
cron.schedule('*/10 * * * * *', monitorTornadoWarnings);
cron.schedule('*/10 * * * * *', monitorMesoscaleDiscussions);

// Start server
app.listen(PORT, () => {
    console.log(`🌪️  Tornado Warning Monitor Server running on port ${PORT}`);
    console.log(`📡 Monitoring Iowa State Mesonet API every 10 seconds`);
    console.log(`🔗 API Documentation: https://mesonet.agron.iastate.edu/geojson/sbw.py?help`);
    
    // Run initial check
    monitorTornadoWarnings();
});

module.exports = app;
