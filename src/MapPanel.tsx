import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet.markercluster'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import { formatViews } from './data'
import { thumbnailImageUrl } from './images'
import type { MapBounds, Place } from './types'

// Suitable for local development and a very small public demo. Before public
// launch, change this to a tile provider whose terms cover your traffic level.
const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
const VIEW_COUNT_MAX = 10_000_000
const VIEW_COUNT_COLORS = ['#37003e', '#13096b', '#005475', '#0095c2', '#00f7ff'] as const
const INDIVIDUAL_MARKER_ZOOM = 8

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

function viewCountColor(viewCount = 0): string {
  const normalized = Math.min(1, Math.log10(Math.max(0, viewCount) + 1) / Math.log10(VIEW_COUNT_MAX + 1))
  const scaled = normalized * (VIEW_COUNT_COLORS.length - 1)
  const startIndex = Math.min(Math.floor(scaled), VIEW_COUNT_COLORS.length - 2)
  const amount = scaled - startIndex
  const toChannels = (hex: string): [number, number, number] => [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ]
  const start = toChannels(VIEW_COUNT_COLORS[startIndex]!)
  const end = toChannels(VIEW_COUNT_COLORS[startIndex + 1]!)
  const channels = start.map((channel, index) => Math.round(channel + (end[index]! - channel) * amount))
  return `rgb(${channels.join(', ')})`
}

function viewCountTextColor(viewCount = 0): string {
  const normalized = Math.min(1, Math.log10(Math.max(0, viewCount) + 1) / Math.log10(VIEW_COUNT_MAX + 1))
  return normalized > 0.72 ? '#172033' : '#ffffff'
}

function viewCountZIndex(viewCount = 0): number {
  return Math.round(Math.log10(Math.max(0, viewCount) + 1) * 1000)
}

function countMarkerIcon(pointCount: number, highestViewCount: number): L.DivIcon {
  const size = pointCount < 10 ? 'small' : pointCount < 100 ? 'medium' : 'large'
  const formattedCount = pointCount.toLocaleString()
  return L.divIcon({
    className: `marker-cluster marker-cluster-${size}`,
    html: `<div title="${formattedCount} places; highest has ${formatViews(highestViewCount)} views"><span>${formattedCount}</span></div>`,
    iconSize: L.point(40, 40),
  })
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
        <span class="map-card-views">${formatViews(place.wikiViewCount ?? 0)} Wikipedia views</span>
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
  const markerViewCountsRef = useRef(new WeakMap<L.Layer, number>())
  const markerPointCountsRef = useRef(new WeakMap<L.Layer, number>())
  const aggregatedModeRef = useRef(false)
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

    const legend = new L.Control({ position: 'bottomright' })
    legend.onAdd = () => {
      const element = L.DomUtil.create('div', 'map-view-legend')
      element.setAttribute('role', 'img')
      element.setAttribute('aria-label', 'Marker color scale for Wikipedia views, from zero to ten million or more')
      element.innerHTML = `
        <strong>Wikipedia views</strong>
        <span class="map-view-gradient" aria-hidden="true"></span>
        <span class="map-view-labels"><span>0</span><span>100K</span><span>10M+</span></span>
      `
      return element
    }
    legend.addTo(map)

    const markers = L.markerClusterGroup({
      chunkedLoading: false,
      chunkInterval: 20,
      chunkDelay: 10,
      maxClusterRadius: 48,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      disableClusteringAtZoom: INDIVIDUAL_MARKER_ZOOM,
      iconCreateFunction: (cluster) => {
        const childMarkers = cluster.getAllChildMarkers()
        const highestViewCount = childMarkers.reduce(
          (highest, marker) => Math.max(highest, markerViewCountsRef.current.get(marker) ?? 0),
          0,
        )
        const pointCount = childMarkers.reduce(
          (total, marker) => total + (markerPointCountsRef.current.get(marker) ?? 1),
          0,
        )
        cluster.setZIndexOffset(viewCountZIndex(highestViewCount))
        return countMarkerIcon(pointCount, highestViewCount)
      },
    })
    markers.addTo(map)

    const bringHighViewMarkersToFront = () => {
      markers.getLayers()
        .sort((first, second) => (markerViewCountsRef.current.get(first) ?? 0) - (markerViewCountsRef.current.get(second) ?? 0))
        .forEach((layer) => {
          if (layer instanceof L.CircleMarker) layer.bringToFront()
        })
    }

    const reportViewport = () => onViewportRef.current(toBounds(map))
    map.on('moveend', reportViewport)
    map.on('zoomend', bringHighViewMarkersToFront)
    mapRef.current = map
    markerLayerRef.current = markers
    reportViewport()

    return () => {
      map.off('moveend', reportViewport)
      map.off('zoomend', bringHighViewMarkersToFront)
      map.remove()
      mapRef.current = null
      markerLayerRef.current = null
    }
  }, [])

  useEffect(() => {
    const markers = markerLayerRef.current
    const map = mapRef.current
    if (!markers || !map) return

    markers.clearLayers()
    const aggregatedMode = places.some((place) => (place.mapPointCount ?? 1) > 1)
    if (aggregatedMode !== aggregatedModeRef.current) {
      map.removeLayer(markers)
      const options = markers.options as L.MarkerClusterGroupOptions
      options.disableClusteringAtZoom = aggregatedMode ? undefined : INDIVIDUAL_MARKER_ZOOM
      markers.addTo(map)
      aggregatedModeRef.current = aggregatedMode
    }

    const placesByViewCount = [...places].sort(
      (first, second) => (first.wikiViewCount ?? 0) - (second.wikiViewCount ?? 0),
    )

    for (const place of placesByViewCount) {
      if (typeof place.latitude !== 'number' || typeof place.longitude !== 'number') continue
      const pointCount = place.mapPointCount ?? 1

      if (pointCount > 1) {
        const marker = L.marker([place.latitude, place.longitude], {
          icon: countMarkerIcon(pointCount, place.wikiViewCount ?? 0),
          zIndexOffset: viewCountZIndex(place.wikiViewCount),
        })
        markerViewCountsRef.current.set(marker, place.wikiViewCount ?? 0)
        markerPointCountsRef.current.set(marker, pointCount)
        marker.on('click', () => {
          const map = mapRef.current
          if (map) map.setView(marker.getLatLng(), Math.min(map.getZoom() + 2, map.getMaxZoom()))
        })
        markers.addLayer(marker)
        continue
      }

      const marker = L.circleMarker([place.latitude, place.longitude], {
        radius: 6,
        weight: 1,
        color: '#ffffff',
        fillColor: viewCountColor(place.wikiViewCount),
        fillOpacity: 0.95,
      })
      markerViewCountsRef.current.set(marker, place.wikiViewCount ?? 0)
      markerPointCountsRef.current.set(marker, 1)

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
