import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet.markercluster'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import { thumbnailImageUrl } from './images'
import type { MapBounds, Place } from './types'

// Suitable for local development and a very small public demo. Before public
// launch, change this to a tile provider whose terms cover your traffic level.
const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'

type Props = {
  places: Place[]
  onOpenPlace: (qid: string) => void
  onViewportChanged: (bounds: MapBounds) => void
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function popupHtml(place: Place): string {
  const translations = [place.labelEn, place.labelZh].filter(Boolean).join(' · ')
  const thumbnail = place.commonsImageUrls[0]
  const image = thumbnail
    ? `<img class="map-card-image" src="${escapeHtml(thumbnailImageUrl(thumbnail, 180))}" alt="" loading="lazy" decoding="async">`
    : '<div class="map-card-image map-card-image-fallback" aria-hidden="true">⌖</div>'
  return `
    <div class="map-card">
      ${image}
      <div class="map-card-copy">
        <strong>${escapeHtml(place.labelNative)}</strong>
        ${translations ? `<span>${escapeHtml(translations)}</span>` : ''}
        ${place.countryLabelEn ? `<span>${escapeHtml(place.countryLabelEn)}</span>` : ''}
        <span class="map-card-badge">${escapeHtml(place.registryName)}</span>
        <span class="map-card-action">Open record →</span>
      </div>
    </div>
  `
}

function toBounds(map: L.Map): MapBounds {
  const bounds = map.getBounds()
  return {
    south: bounds.getSouth(),
    west: bounds.getWest(),
    north: bounds.getNorth(),
    east: bounds.getEast(),
    zoom: map.getZoom(),
  }
}

export function MapPanel({ places, onOpenPlace, onViewportChanged }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markerLayerRef = useRef<L.MarkerClusterGroup | null>(null)
  const onOpenRef = useRef(onOpenPlace)
  const onViewportRef = useRef(onViewportChanged)

  useEffect(() => {
    onOpenRef.current = onOpenPlace
  }, [onOpenPlace])

  useEffect(() => {
    onViewportRef.current = onViewportChanged
  }, [onViewportChanged])

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const map = L.map(containerRef.current, {
      zoomControl: false,
      preferCanvas: true,
    }).setView([46, 10], 4)

    L.control.zoom({ position: 'topright' }).addTo(map)
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map)
    L.tileLayer(TILE_URL, {
      maxZoom: 19,
      attribution: TILE_ATTRIBUTION,
    }).addTo(map)

    const markers = L.markerClusterGroup({
      chunkedLoading: false,
      chunkInterval: 20,
      chunkDelay: 10,
      maxClusterRadius: 20,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      disableClusteringAtZoom: 8,
    })
    markers.addTo(map)

    const reportViewport = () => onViewportRef.current(toBounds(map))
    map.on('moveend', reportViewport)
    mapRef.current = map
    markerLayerRef.current = markers
    reportViewport()

    return () => {
      map.off('moveend', reportViewport)
      map.remove()
      mapRef.current = null
      markerLayerRef.current = null
    }
  }, [])

  useEffect(() => {
    const markers = markerLayerRef.current
    if (!markers) return

    markers.clearLayers()

    for (const place of places) {
      if (typeof place.latitude !== 'number' || typeof place.longitude !== 'number') continue

      const marker = L.circleMarker([place.latitude, place.longitude], {
        radius: 7,
        weight: 2,
        color: '#ffffff',
        fillColor: '#a05012',
        fillOpacity: 0.95,
      })

      marker.bindTooltip(popupHtml(place), {
        className: 'place-map-tooltip',
        direction: 'top',
        offset: [0, -10],
        opacity: 1,
      })
      marker.bindPopup(popupHtml(place), { closeButton: false, offset: [0, -2] })
      marker.on('click', () => onOpenRef.current(place.qid))
      markers.addLayer(marker)
    }
  }, [places])

  return <div ref={containerRef} className="map" aria-label="Interactive heritage map" />
}
