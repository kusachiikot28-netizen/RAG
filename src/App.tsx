import React, { useState, useRef, useEffect, useCallback } from 'react';
import { MapContainer, TileLayer, Polyline, useMap, useMapEvents, Marker, Popup, ImageOverlay } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { 
  Upload, 
  Map as MapIcon, 
  Settings, 
  Download, 
  Play, 
  Trash2, 
  ChevronRight, 
  ChevronLeft,
  Activity,
  Maximize,
  Move,
  RotateCcw,
  Info
} from 'lucide-react';
import axios from 'axios';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Utility for tailwind classes
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Fix for default marker icons in Leaflet with React
// @ts-ignore
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

interface Point {
  lat: number;
  lng: number;
}

interface GenerationParams {
  scale: number; // in km
  activityType: 'run' | 'bike';
  mode: 'contour' | 'fill';
  rotation: number;
  opacity: number;
}

export default function App() {
  const [mapCenter, setMapCenter] = useState<[number, number]>([55.7558, 37.6173]); // Moscow default
  const [zoom, setZoom] = useState(13);
  const [uploadedImage, setUploadedImage] = useState<string | null>(null);
  const [imageBounds, setImageBounds] = useState<L.LatLngBoundsExpression | null>(null);
  const [imagePoints, setImagePoints] = useState<Point[]>([]);
  const [generatedRoute, setGeneratedRoute] = useState<Point[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [params, setParams] = useState<GenerationParams>({
    scale: 2,
    activityType: 'run',
    mode: 'contour',
    rotation: 0,
    opacity: 0.5
  });
  const [status, setStatus] = useState<string>('');

  const mapRef = useRef<L.Map | null>(null);

  // Handle image upload and vectorization
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      setUploadedImage(dataUrl);
      processImage(dataUrl);
    };
    reader.readAsDataURL(file);
  };

  const processImage = (dataUrl: string) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Resize for processing
      const maxDim = 200;
      const scale = Math.min(maxDim / img.width, maxDim / img.height);
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      // Simple edge detection/contour extraction
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      const points: { x: number, y: number }[] = [];

      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const idx = (y * canvas.width + x) * 4;
          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          const a = data[idx + 3];

          // If dark and not transparent
          const brightness = (r + g + b) / 3;
          if (brightness < 128 && a > 128) {
            // Check neighbors for edge
            let isEdge = false;
            if (x > 0 && x < canvas.width - 1 && y > 0 && y < canvas.height - 1) {
              const neighbors = [
                ((y - 1) * canvas.width + x) * 4,
                ((y + 1) * canvas.width + x) * 4,
                (y * canvas.width + x - 1) * 4,
                (y * canvas.width + x + 1) * 4
              ];
              for (const nIdx of neighbors) {
                if (data[nIdx + 3] < 128 || (data[nIdx] + data[nIdx + 1] + data[nIdx + 2]) / 3 > 128) {
                  isEdge = true;
                  break;
                }
              }
            } else {
              isEdge = true;
            }

            if (isEdge) {
              points.push({ x: x / canvas.width, y: y / canvas.height });
            }
          }
        }
      }

      // Simplify points (take every Nth point to avoid overwhelming the server)
      const simplified = points.filter((_, i) => i % 5 === 0);
      
      // Convert to relative coordinates from center
      const relativePoints = simplified.map(p => ({
        x: p.x - 0.5,
        y: p.y - 0.5
      }));

      // Initial mapping to map coordinates
      updateMapPoints(relativePoints, mapCenter, params.scale);
    };
    img.src = dataUrl;
  };

  const updateMapPoints = (relPoints: {x: number, y: number}[], center: [number, number], scaleKm: number) => {
    const latPerKm = 1 / 111;
    const lngPerKm = 1 / (111 * Math.cos(center[0] * Math.PI / 180));

    const mapped = relPoints.map(p => ({
      lat: center[0] - p.y * scaleKm * latPerKm,
      lng: center[1] + p.x * scaleKm * lngPerKm
    }));

    setImagePoints(mapped);
    
    // Update image overlay bounds
    const halfLat = (scaleKm / 2) * latPerKm;
    const halfLng = (scaleKm / 2) * lngPerKm;
    setImageBounds([
      [center[0] - halfLat, center[1] - halfLng],
      [center[0] + halfLat, center[1] + halfLng]
    ]);
  };

  useEffect(() => {
    if (uploadedImage) {
      // Re-process points if scale or center changes
      // This is a simplified version, ideally we'd store relativePoints
    }
  }, [params.scale, mapCenter]);

  const generateRoute = async () => {
    if (imagePoints.length === 0) return;
    
    setIsGenerating(true);
    setStatus('Fetching road network and generating route...');
    
    try {
      // Calculate bounds for OSM query
      const lats = imagePoints.map(p => p.lat);
      const lngs = imagePoints.map(p => p.lng);
      const padding = 0.005; // ~500m
      const bounds = {
        south: Math.min(...lats) - padding,
        west: Math.min(...lngs) - padding,
        north: Math.max(...lats) + padding,
        east: Math.max(...lngs) + padding
      };

      const response = await axios.post('/api/generate-route', {
        points: imagePoints,
        bounds,
        activityType: params.activityType
      });

      setGeneratedRoute(response.data.route);
      setStatus('Route generated successfully!');
    } catch (error: any) {
      console.error(error);
      setStatus(`Error: ${error.response?.data?.error || error.message}`);
    } finally {
      setIsGenerating(false);
    }
  };

  const downloadGPX = async () => {
    if (generatedRoute.length === 0) return;
    
    try {
      const response = await axios.post('/api/export-gpx', {
        route: generatedRoute,
        name: 'RouteArt'
      }, { responseType: 'blob' });
      
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', 'route.gpx');
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (error) {
      console.error(error);
    }
  };

  return (
    <div className="flex h-full w-full bg-zinc-50 font-sans text-zinc-900">
      {/* Sidebar */}
      <div className={cn(
        "relative z-20 flex h-full flex-col border-r border-zinc-200 bg-white transition-all duration-300 ease-in-out",
        sidebarOpen ? "w-80" : "w-0 overflow-hidden"
      )}>
        <div className="flex items-center justify-between border-b border-zinc-100 p-4">
          <div className="flex items-center gap-2">
            <Activity className="h-6 w-6 text-orange-600" />
            <h1 className="text-xl font-bold tracking-tight">RouteArt</h1>
          </div>
          <button 
            onClick={() => setSidebarOpen(false)}
            className="rounded-full p-1 hover:bg-zinc-100"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {/* Step 1: Upload */}
          <section className="space-y-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-500">
              <Upload className="h-4 w-4" /> 1. Upload Image
            </h2>
            <div className="group relative flex h-32 w-full cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-zinc-300 bg-zinc-50 transition-colors hover:border-orange-400 hover:bg-orange-50">
              <input 
                type="file" 
                className="absolute inset-0 opacity-0 cursor-pointer" 
                accept="image/*"
                onChange={handleImageUpload}
              />
              {uploadedImage ? (
                <img src={uploadedImage} alt="Preview" className="h-full w-full object-contain p-2" />
              ) : (
                <>
                  <Upload className="mb-2 h-8 w-8 text-zinc-400 group-hover:text-orange-500" />
                  <span className="text-xs font-medium text-zinc-500 group-hover:text-orange-600">Click or drag image</span>
                </>
              )}
            </div>
          </section>

          {/* Step 2: Settings */}
          <section className="space-y-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-500">
              <Settings className="h-4 w-4" /> 2. Parameters
            </h2>
            
            <div className="space-y-2">
              <label className="text-xs font-medium text-zinc-600">Scale (km)</label>
              <input 
                type="range" min="0.5" max="10" step="0.5" 
                value={params.scale}
                onChange={(e) => setParams({...params, scale: parseFloat(e.target.value)})}
                className="w-full accent-orange-600"
              />
              <div className="flex justify-between text-[10px] font-mono text-zinc-400">
                <span>0.5km</span>
                <span className="font-bold text-orange-600">{params.scale}km</span>
                <span>10km</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button 
                onClick={() => setParams({...params, activityType: 'run'})}
                className={cn(
                  "flex items-center justify-center gap-2 rounded-lg border py-2 text-xs font-medium transition-all",
                  params.activityType === 'run' ? "border-orange-600 bg-orange-50 text-orange-700" : "border-zinc-200 hover:bg-zinc-50"
                )}
              >
                Running
              </button>
              <button 
                onClick={() => setParams({...params, activityType: 'bike'})}
                className={cn(
                  "flex items-center justify-center gap-2 rounded-lg border py-2 text-xs font-medium transition-all",
                  params.activityType === 'bike' ? "border-orange-600 bg-orange-50 text-orange-700" : "border-zinc-200 hover:bg-zinc-50"
                )}
              >
                Cycling
              </button>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium text-zinc-600">Overlay Opacity</label>
              <input 
                type="range" min="0" max="1" step="0.1" 
                value={params.opacity}
                onChange={(e) => setParams({...params, opacity: parseFloat(e.target.value)})}
                className="w-full accent-zinc-600"
              />
            </div>
          </section>

          {/* Step 3: Generate */}
          <section className="pt-4">
            <button 
              disabled={!uploadedImage || isGenerating}
              onClick={generateRoute}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-orange-600 py-3 font-bold text-white shadow-lg shadow-orange-200 transition-all hover:bg-orange-700 hover:shadow-orange-300 disabled:bg-zinc-300 disabled:shadow-none"
            >
              {isGenerating ? (
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
              ) : (
                <Play className="h-5 w-5 fill-current" />
              )}
              {isGenerating ? 'Generating...' : 'Generate Route'}
            </button>
            {status && (
              <p className="mt-2 text-center text-[10px] font-medium text-zinc-500">{status}</p>
            )}
          </section>

          {/* Step 4: Export */}
          {generatedRoute.length > 0 && (
            <section className="space-y-3 pt-4">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">3. Export</h2>
              <button 
                onClick={downloadGPX}
                className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-zinc-900 py-3 font-bold text-zinc-900 transition-all hover:bg-zinc-900 hover:text-white"
              >
                <Download className="h-5 w-5" /> Download GPX
              </button>
            </section>
          )}
        </div>

        <div className="border-t border-zinc-100 p-4 text-[10px] text-zinc-400">
          <p>© 2026 RouteArt Generator. Powered by OSM & Gemini.</p>
        </div>
      </div>

      {/* Map Area */}
      <div className="relative flex-1">
        {!sidebarOpen && (
          <button 
            onClick={() => setSidebarOpen(true)}
            className="absolute left-4 top-4 z-30 rounded-full bg-white p-2 shadow-md hover:bg-zinc-50"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        )}

        <div className="absolute right-4 top-4 z-30 flex flex-col gap-2">
          <div className="flex flex-col overflow-hidden rounded-lg bg-white shadow-md">
            <button className="p-2 hover:bg-zinc-50 border-b border-zinc-100" title="Recenter">
              <Move className="h-5 w-5 text-zinc-600" />
            </button>
            <button 
              onClick={() => {
                setGeneratedRoute([]);
                setImagePoints([]);
                setUploadedImage(null);
                setImageBounds(null);
              }}
              className="p-2 hover:bg-zinc-50" 
              title="Clear All"
            >
              <Trash2 className="h-5 w-5 text-red-500" />
            </button>
          </div>
          
          <div className="rounded-lg bg-white p-2 shadow-md">
            <Info className="h-5 w-5 text-zinc-400" />
          </div>
        </div>

        <MapContainer 
          center={mapCenter} 
          zoom={zoom} 
          className="h-full w-full"
          ref={mapRef}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          
          <MapEventsHandler 
            onMove={(center) => setMapCenter([center.lat, center.lng])}
            onZoom={(z) => setZoom(z)}
          />

          {uploadedImage && imageBounds && (
            <ImageOverlay
              url={uploadedImage}
              bounds={imageBounds}
              opacity={params.opacity}
            />
          )}

          {generatedRoute.length > 0 && (
            <Polyline 
              positions={generatedRoute.map(p => [p.lat, p.lng])} 
              color="#ea580c" 
              weight={4}
              opacity={0.8}
            />
          )}

          {/* Debug: show image points */}
          {/* {imagePoints.length > 0 && imagePoints.map((p, i) => (
            <Circle key={i} center={[p.lat, p.lng]} radius={2} color="blue" />
          ))} */}
        </MapContainer>

        {/* Legend/Status Overlay */}
        <div className="absolute bottom-6 left-1/2 z-30 -translate-x-1/2">
          <div className="flex items-center gap-4 rounded-full bg-zinc-900/90 px-6 py-3 text-white backdrop-blur-sm shadow-2xl">
            <div className="flex items-center gap-2">
              <div className="h-3 w-3 rounded-full bg-orange-500 shadow-[0_0_8px_rgba(249,115,22,0.8)]" />
              <span className="text-xs font-bold uppercase tracking-wider">Route</span>
            </div>
            <div className="h-4 w-px bg-zinc-700" />
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono text-zinc-400">Distance:</span>
              <span className="text-xs font-bold">{(generatedRoute.length * 0.05).toFixed(1)} km</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MapEventsHandler({ onMove, onZoom }: { onMove: (center: L.LatLng) => void, onZoom: (zoom: number) => void }) {
  const map = useMapEvents({
    moveend: () => {
      onMove(map.getCenter());
    },
    zoomend: () => {
      onZoom(map.getZoom());
    }
  });
  return null;
}
