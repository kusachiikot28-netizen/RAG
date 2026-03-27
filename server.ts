import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import createGraph from "ngraph.graph";
import pathfinding from "ngraph.path";
import { create } from "xmlbuilder2";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '10mb' }));

  // API Routes
  app.post("/api/generate-route", async (req, res) => {
    try {
      const { points, bounds, activityType } = req.body;
      
      // 1. Fetch OSM data for the bounds
      // Overpass API query for roads/paths
      const south = bounds.south;
      const west = bounds.west;
      const north = bounds.north;
      const east = bounds.east;
      
      const highwayFilter = activityType === 'bike' 
        ? '["highway"~"cycleway|residential|tertiary|secondary|primary|unclassified|service|path|track"]'
        : '["highway"~"footway|pedestrian|path|residential|service|track|unclassified"]';

      const query = `
        [out:json][timeout:25];
        (
          way${highwayFilter}(${south},${west},${north},${east});
        );
        out body;
        >;
        out skel qt;
      `;

      const osmResponse = await axios.post("https://overpass-api.de/api/interpreter", `data=${encodeURIComponent(query)}`);
      const osmData = osmResponse.data;

      // 2. Build graph
      const graph = createGraph();
      const nodesMap = new Map();

      osmData.elements.forEach((el: any) => {
        if (el.type === "node") {
          nodesMap.set(el.id, { lat: el.lat, lon: el.lon });
        }
      });

      osmData.elements.forEach((el: any) => {
        if (el.type === "way") {
          for (let i = 0; i < el.nodes.length - 1; i++) {
            const fromId = el.nodes[i];
            const toId = el.nodes[i + 1];
            const fromNode = nodesMap.get(fromId);
            const toNode = nodesMap.get(toId);

            if (fromNode && toNode) {
              // Calculate distance as weight
              const dist = Math.sqrt(
                Math.pow(fromNode.lat - toNode.lat, 2) + 
                Math.pow(fromNode.lon - toNode.lon, 2)
              );
              graph.addLink(fromId, toId, { weight: dist });
              graph.addLink(toId, fromId, { weight: dist });
            }
          }
        }
      });

      // 3. Snap input points to nearest graph nodes
      const findNearestNode = (lat: number, lon: number) => {
        let minInfo = { id: null, dist: Infinity };
        nodesMap.forEach((node, id) => {
          const d = Math.pow(node.lat - lat, 2) + Math.pow(node.lon - lon, 2);
          if (d < minInfo.dist) {
            minInfo = { id, dist: d };
          }
        });
        return minInfo.id;
      };

      const snappedNodeIds = points.map((p: any) => findNearestNode(p.lat, p.lng)).filter((id: any) => id !== null);

      if (snappedNodeIds.length < 2) {
        return res.status(400).json({ error: "Not enough points snapped to roads." });
      }

      // 4. Find path between snapped nodes
      const finder = pathfinding.aStar(graph, {
        distance(fromNode, toNode, link) {
          return link.data.weight;
        }
      });

      let fullPath: any[] = [];
      for (let i = 0; i < snappedNodeIds.length - 1; i++) {
        const segment = finder.find(snappedNodeIds[i], snappedNodeIds[i + 1]);
        if (segment && segment.length > 0) {
          // segment is returned in reverse order
          const coords = segment.reverse().map((node: any) => {
            const data = nodesMap.get(node.id);
            return { lat: data.lat, lng: data.lon };
          });
          
          // Avoid duplicating points at connections
          if (fullPath.length > 0) {
            fullPath = fullPath.concat(coords.slice(1));
          } else {
            fullPath = coords;
          }
        }
      }

      if (fullPath.length === 0) {
        return res.status(400).json({ error: "Could not find a path along the roads." });
      }

      res.json({ route: fullPath });
    } catch (error: any) {
      console.error("Route generation error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/export-gpx", (req, res) => {
    const { route, name } = req.body;
    
    const root = create({ version: '1.0', encoding: 'UTF-8' })
      .ele('gpx', {
        version: '1.1',
        creator: 'RouteArt Generator',
        xmlns: 'http://www.topografix.com/GPX/1/1'
      })
      .ele('trk')
        .ele('name').txt(name || 'RouteArt').up()
        .ele('trkseg');

    route.forEach((p: any) => {
      root.ele('trkpt', { lat: p.lat, lon: p.lng })
        .ele('time').txt(new Date().toISOString()).up()
      .up();
    });

    const xml = root.end({ prettyPrint: true });
    res.header('Content-Type', 'application/gpx+xml');
    res.header('Content-Disposition', `attachment; filename="${name || 'route'}.gpx"`);
    res.send(xml);
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
