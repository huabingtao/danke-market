import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

const DATA_FILE = path.resolve(__dirname, 'board_data.json')
const RESET_STATUS_FILE = path.resolve(__dirname, '.last_reset_date')

function checkAndResetData() {
  const now = new Date();
  // Formatting to YYYY-MM-DD local format
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const currentDateStr = `${year}-${month}-${day}`;
  const currentHour = now.getHours();

  if (currentHour >= 18) {
    let lastResetDate = '';
    if (fs.existsSync(RESET_STATUS_FILE)) {
      lastResetDate = fs.readFileSync(RESET_STATUS_FILE, 'utf-8').trim();
    }

    if (lastResetDate !== currentDateStr) {
      try {
        const emptyData = {
          egg: [],
          milk: [],
          goose: [],
          honey: [],
          wool: [],
          feather: []
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(emptyData, null, 2), 'utf-8');
        fs.writeFileSync(RESET_STATUS_FILE, currentDateStr, 'utf-8');
        console.log(`[Auto-Reset] Data auto-cleared at 18:00 reset check (${now.toLocaleString()})`);
      } catch (e) {
        console.error('Failed to auto-reset data:', e);
      }
    }
  }
}

function syncApiPlugin() {
  return {
    name: 'vite-plugin-sync-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // Handle GET /api/load
        if (req.url === '/api/load' && req.method === 'GET') {
          checkAndResetData();
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          if (fs.existsSync(DATA_FILE)) {
            const data = fs.readFileSync(DATA_FILE, 'utf-8')
            res.end(data)
          } else {
            res.end(JSON.stringify({}))
          }
        } 
        // Handle POST /api/save
        else if (req.url === '/api/save' && req.method === 'POST') {
          let body = ''
          req.on('data', chunk => {
            body += chunk
          })
          req.on('end', () => {
            try {
              fs.writeFileSync(DATA_FILE, body, 'utf-8')
              res.setHeader('Content-Type', 'application/json')
              res.setHeader('Access-Control-Allow-Origin', '*')
              res.end(JSON.stringify({ status: 'success' }))
            } catch (err) {
              res.statusCode = 500
              res.end(JSON.stringify({ error: err.message }))
            }
          })
        } 
        // Forward to next middleware if not matching api endpoints
        else {
          next()
        }
      })
    }
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), syncApiPlugin()],
  server: {
    host: true
  }
})
