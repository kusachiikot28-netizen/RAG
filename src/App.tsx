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
  Info,
  Layers,
  Zap,
  CheckCircle2,
  AlertCircle
} from 'lucide-react';
import axios from 'axios';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { motion, AnimatePresence } from 'motion/react';

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
  const [mapCenter, setMapCenter] = useState<[number, number]>([52.979167, 36.065278]); // Orel, Russia
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
    opacity: 0.6
  });
  const [status, setStatus] = useState<{message: string, type: 'info' | 'success' | 'error' | null}>({
    message: '',
    type: null
  });

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

      const maxDim = 200;
      const scale = Math.min(maxDim / img.width, maxDim / img.height);
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

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

          const brightness = (r + g + b) / 3;
          if (brightness < 128 && a > 128) {
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

      const simplified = points.filter((_, i) => i % 5 === 0);
      const relativePoints = simplified.map(p => ({ x: p.x - 0.5, y: p.y - 0.5 }));
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
    const halfLat = (scaleKm / 2) * latPerKm;
    const halfLng = (scaleKm / 2) * lngPerKm;
    setImageBounds([
      [center[0] - halfLat, center[1] - halfLng],
      [center[0] + halfLat, center[1] + halfLng]
    ]);
  };

  const generateRoute = async () => {
    if (imagePoints.length === 0) return;
    
    setIsGenerating(true);
    setStatus({ message: 'Analyzing road network...', type: 'info' });
    
    try {
      const lats = imagePoints.map(p => p.lat);
      const lngs = imagePoints.map(p => p.lng);
      const padding = 0.005;
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
      setStatus({ message: 'Route generated successfully!', type: 'success' });
    } catch (error: any) {
      console.error(error);
      setStatus({ 
        message: error.response?.data?.error || error.message, 
        type: 'error' 
      });
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
    <div className="flex h-full w-full bg-zinc-950 font-sans text-zinc-100 antialiased">
      {/* Sidebar */}
      <AnimatePresence mode="wait">
        {sidebarOpen && (
          <motion.div 
            initial={{ x: -320 }}
            animate={{ x: 0 }}
            exit={{ x: -320 }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="relative z-40 flex h-full w-80 flex-col border-r border-zinc-800 bg-zinc-950/90 backdrop-blur-xl"
          >
            <div className="flex items-center justify-between border-b border-zinc-800 p-6">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-600 shadow-lg shadow-orange-900/20">
                  <Activity className="h-6 w-6 text-white" />
                </div>
                <div>
                  <h1 className="text-lg font-bold tracking-tight text-white">RouteArt</h1>
                  <p className="text-[10px] font-medium uppercase tracking-widest text-zinc-500">Generator v1.0</p>
                </div>
              </div>
              <button 
                onClick={() => setSidebarOpen(false)}
                className="rounded-full p-2 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-6 space-y-8">
              {/* Step 1: Upload */}
              <section className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-zinc-500">
                    <Upload className="h-3.5 w-3.5" /> 01. Source Image
                  </h2>
                </div>
                <div className="group relative flex h-40 w-full cursor-pointer flex-col items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed border-zinc-800 bg-zinc-900/50 transition-all hover:border-orange-500/50 hover:bg-orange-500/5">
                  <input 
                    type="file" 
                    className="absolute inset-0 z-10 opacity-0 cursor-pointer" 
                    accept="image/*"
                    onChange={handleImageUpload}
                  />
                  {uploadedImage ? (
                    <img src={uploadedImage} alt="Preview" className="h-full w-full object-contain p-4 transition-transform group-hover:scale-105" />
                  ) : (
                    <>
                      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-zinc-800 transition-colors group-hover:bg-orange-500/20">
                        <Upload className="h-6 w-6 text-zinc-400 group-hover:text-orange-500" />
                      </div>
                      <span className="text-xs font-semibold text-zinc-400 group-hover:text-orange-400">Drop image here</span>
                      <span className="mt-1 text-[10px] text-zinc-600">PNG, JPG, SVG</span>
                    </>
                  )}
                </div>
              </section>

              {/* Step 2: Parameters */}
              <section className="space-y-6">
                <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-zinc-500">
                  <Settings className="h-3.5 w-3.5" /> 02. Parameters
                </h2>
                
                <div className="space-y-4 rounded-2xl bg-zinc-900/50 p-4 border border-zinc-800/50">
                  <div className="space-y-3">
                    <div className="flex justify-between">
                      <label className="text-xs font-bold text-zinc-400">Scale</label>
                      <span className="text-xs font-mono font-bold text-orange-500">{params.scale} km</span>
                    </div>
                    <input 
                      type="range" min="0.5" max="10" step="0.5" 
                      value={params.scale}
                      onChange={(e) => setParams({...params, scale: parseFloat(e.target.value)})}
                      className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-orange-600"
                    />
                  </div>

                  <div className="space-y-3">
                    <label className="text-xs font-bold text-zinc-400">Activity Type</label>
                    <div className="grid grid-cols-2 gap-2">
                      <button 
                        onClick={() => setParams({...params, activityType: 'run'})}
                        className={cn(
                          "flex items-center justify-center gap-2 rounded-xl border py-2.5 text-xs font-bold transition-all",
                          params.activityType === 'run' 
                            ? "border-orange-500 bg-orange-500/10 text-orange-500" 
                            : "border-zinc-800 bg-zinc-900/50 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300"
                        )}
                      >
                        Running
                      </button>
                      <button 
                        onClick={() => setParams({...params, activityType: 'bike'})}
                        className={cn(
                          "flex items-center justify-center gap-2 rounded-xl border py-2.5 text-xs font-bold transition-all",
                          params.activityType === 'bike' 
                            ? "border-orange-500 bg-orange-500/10 text-orange-500" 
                            : "border-zinc-800 bg-zinc-900/50 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300"
                        )}
                      >
                        Cycling
                      </button>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div className="flex justify-between">
                      <label className="text-xs font-bold text-zinc-400">Overlay Opacity</label>
                      <span className="text-xs font-mono text-zinc-500">{Math.round(params.opacity * 100)}%</span>
                    </div>
                    <input 
                      type="range" min="0" max="1" step="0.1" 
                      value={params.opacity}
                      onChange={(e) => setParams({...params, opacity: parseFloat(e.target.value)})}
                      className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-zinc-600"
                    />
                  </div>
                </div>
              </section>

              {/* Step 3: Action */}
              <section className="pt-2">
                <button 
                  disabled={!uploadedImage || isGenerating}
                  onClick={generateRoute}
                  className={cn(
                    "relative flex w-full items-center justify-center gap-3 overflow-hidden rounded-2xl py-4 font-black transition-all active:scale-95",
                    "bg-orange-600 text-white shadow-xl shadow-orange-900/20 hover:bg-orange-500 hover:shadow-orange-900/40",
                    "disabled:bg-zinc-800 disabled:text-zinc-600 disabled:shadow-none disabled:active:scale-100"
                  )}
                >
                  {isGenerating ? (
                    <motion.div 
                      animate={{ rotate: 360 }}
                      transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
                      className="h-5 w-5 rounded-full border-2 border-white border-t-transparent"
                    />
                  ) : (
                    <Zap className="h-5 w-5 fill-current" />
                  )}
                  <span className="uppercase tracking-widest">{isGenerating ? 'Processing...' : 'Generate Route'}</span>
                </button>
                
                <AnimatePresence>
                  {status.message && (
                    <motion.div 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 10 }}
                      className={cn(
                        "mt-4 flex items-start gap-3 rounded-xl p-3 text-[11px] font-medium leading-relaxed",
                        status.type === 'success' ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" :
                        status.type === 'error' ? "bg-red-500/10 text-red-400 border border-red-500/20" :
                        "bg-blue-500/10 text-blue-400 border border-blue-500/20"
                      )}
                    >
                      {status.type === 'success' ? <CheckCircle2 className="h-4 w-4 shrink-0" /> :
                       status.type === 'error' ? <AlertCircle className="h-4 w-4 shrink-0" /> :
                       <Info className="h-4 w-4 shrink-0" />}
                      {status.message}
                    </motion.div>
                  )}
                </AnimatePresence>
              </section>

              {/* Step 4: Export */}
              {generatedRoute.length > 0 && (
                <motion.section 
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="space-y-4 pt-4"
                >
                  <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-500">03. Export</h2>
                  <button 
                    onClick={downloadGPX}
                    className="flex w-full items-center justify-center gap-3 rounded-2xl border-2 border-zinc-100 bg-zinc-100 py-4 font-black text-zinc-950 transition-all hover:bg-white hover:border-white active:scale-95"
                  >
                    <Download className="h-5 w-5" /> 
                    <span className="uppercase tracking-widest">Download GPX</span>
                  </button>
                </motion.section>
              )}
            </div>

            <div className="border-t border-zinc-900 p-6 text-[10px] font-medium text-zinc-600">
              <div className="flex items-center gap-2">
                <div className="h-1 w-1 rounded-full bg-emerald-500 animate-pulse" />
                <span>System Online</span>
              </div>
              <p className="mt-1">© 2026 RouteArt. Built with precision.</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Map Area */}
      <div className="relative flex-1 bg-zinc-950">
        {!sidebarOpen && (
          <motion.button 
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            onClick={() => setSidebarOpen(true)}
            className="absolute left-6 top-6 z-50 flex h-12 w-12 items-center justify-center rounded-2xl bg-zinc-900 text-white shadow-2xl border border-zinc-800 hover:bg-zinc-800 transition-colors"
          >
            <ChevronRight className="h-6 w-6" />
          </motion.button>
        )}

        {/* Floating Controls */}
        <div className="absolute right-6 top-6 z-50 flex flex-col gap-3">
          <div className="flex flex-col overflow-hidden rounded-2xl bg-zinc-900/80 backdrop-blur-md shadow-2xl border border-zinc-800">
            <button className="p-3 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors border-b border-zinc-800" title="Recenter">
              <Move className="h-5 w-5" />
            </button>
            <button 
              onClick={() => {
                setGeneratedRoute([]);
                setImagePoints([]);
                setUploadedImage(null);
                setImageBounds(null);
                setStatus({ message: '', type: null });
              }}
              className="p-3 text-zinc-400 hover:bg-red-500/20 hover:text-red-500 transition-colors" 
              title="Reset All"
            >
              <Trash2 className="h-5 w-5" />
            </button>
          </div>
          
          <button className="flex h-11 w-11 items-center justify-center rounded-2xl bg-zinc-900/80 backdrop-blur-md shadow-2xl border border-zinc-800 text-zinc-400 hover:text-white transition-colors">
            <Layers className="h-5 w-5" />
          </button>
        </div>

        {/* Map */}
        <MapContainer 
          center={mapCenter} 
          zoom={zoom} 
          zoomControl={false}
          className="h-full w-full"
          ref={mapRef}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
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
              color="#f97316" 
              weight={4}
              opacity={0.9}
              lineCap="round"
              lineJoin="round"
              className="route-glow"
            />
          )}
        </MapContainer>

        {/* Stats Overlay */}
        <AnimatePresence>
          {generatedRoute.length > 0 && (
            <motion.div 
              initial={{ opacity: 0, y: 40 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 40 }}
              className="absolute bottom-10 left-1/2 z-50 -translate-x-1/2"
            >
              <div className="flex items-center gap-6 rounded-3xl bg-zinc-900/90 px-8 py-4 text-white backdrop-blur-xl shadow-[0_20px_50px_rgba(0,0,0,0.5)] border border-zinc-800">
                <div className="flex items-center gap-3">
                  <div className="h-3 w-3 rounded-full bg-orange-500 shadow-[0_0_15px_rgba(249,115,22,0.8)]" />
                  <span className="text-xs font-black uppercase tracking-widest">Active Route</span>
                </div>
                <div className="h-6 w-px bg-zinc-800" />
                <div className="flex flex-col">
                  <span className="text-[9px] font-bold uppercase tracking-tighter text-zinc-500">Distance</span>
                  <span className="text-lg font-black font-mono leading-none">{(generatedRoute.length * 0.05).toFixed(2)} <span className="text-[10px] text-zinc-500">KM</span></span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[9px] font-bold uppercase tracking-tighter text-zinc-500">Est. Time</span>
                  <span className="text-lg font-black font-mono leading-none">{Math.round(generatedRoute.length * 0.05 * 6)} <span className="text-[10px] text-zinc-500">MIN</span></span>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
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
