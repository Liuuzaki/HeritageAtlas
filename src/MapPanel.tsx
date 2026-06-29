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
const VIEW_COUNT_COLORS = ['#27003e', '#09306b', '#2469ff', '#00a2ff', '#00fff2'] as const
const SITELINK_COUNT_MAX = 100
const INDIVIDUAL_MARKER_ZOOM = 8
const CLUSTER_ICON_SIZE = 32

type ColorMetric = 'views' | 'sitelinks'
type MetricConfig = {
  title: string
  noun: string
  max: number
  middleValue: number
  middleLabel: string
  maxLabel: string
  format: (value: number) => string
}

const METRIC_CONFIGS: Record<ColorMetric, MetricConfig> = {
  views: {
    title: 'Wikipedia views',
    noun: 'views',
    max: VIEW_COUNT_MAX,
    middleValue: 100_000,
    middleLabel: '100K',
    maxLabel: '10M+',
    format: formatViews,
  },
  sitelinks: {
    title: 'Wikipedia sitelinks',
    noun: 'sitelinks',
    max: SITELINK_COUNT_MAX,
    middleValue: 10,
    middleLabel: '10',
    maxLabel: '100+',
    format: (value) => value.toLocaleString(),
  },
}

type Props = {
  places: Place[]
  dataKey: string
  colorMetric: ColorMetric
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

function normalizedMetricValue(value: number, max: number): number {
  return Math.min(1, Math.log10(Math.max(0, value) + 1) / Math.log10(max + 1))
}

function metricColor(value: number, max: number): string {
  const normalized = normalizedMetricValue(value, max)
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

function metricTextColor(value: number, max: number): string {
  return normalizedMetricValue(value, max) > 0.72 ? '#172033' : '#ffffff'
}

function metricZIndex(value: number, max: number): number {
  return Math.round(normalizedMetricValue(value, max) * 10_000)
}

function metricValue(place: Place, metric: ColorMetric): number {
  return metric === 'sitelinks' ? place.wikipediaSitelinksCount : (place.wikiViewCount ?? 0)
}

function wikipediaPopularityScore(value: number): string {
  return value > SITELINK_COUNT_MAX ? `${SITELINK_COUNT_MAX}+` : value.toLocaleString()
}

function countMarkerIcon(pointCount: number, highestValue: number, config: MetricConfig): L.DivIcon {
  const formattedCount = pointCount.toLocaleString()
  const color = metricColor(highestValue, config.max)
  const textColor = metricTextColor(highestValue, config.max)
  return L.divIcon({
    className: 'marker-cluster view-count-cluster',
    html: `<span style="--cluster-color: ${color}; --cluster-text-color: ${textColor}" title="${formattedCount} places; highest has ${config.format(highestValue)} ${config.noun}">${formattedCount}</span>`,
    iconSize: L.point(CLUSTER_ICON_SIZE, CLUSTER_ICON_SIZE),
  })
}

function updateLegend(element: HTMLDivElement, config: MetricConfig): void {
  const middlePosition = normalizedMetricValue(config.middleValue, config.max) * 100
  element.setAttribute('aria-label', `Marker color scale for ${config.title}, from zero to ${config.maxLabel}`)
  element.innerHTML = `
    <strong>${config.title}</strong>
    <span class="map-view-gradient" style="background: linear-gradient(90deg, ${VIEW_COUNT_COLORS.join(', ')})" aria-hidden="true"></span>
    <span class="map-view-labels"><span>0</span><span style="left: ${middlePosition}%">${config.middleLabel}</span><span>${config.maxLabel}</span></span>
  `
}

function popupHtml(place: Place, metric: ColorMetric): string {
  const translations = [place.labelEn, place.labelZh].filter(Boolean).join(' · ')
  const designation = place.designations[0]
  const popularityTitle = `${place.wikipediaSitelinksCount.toLocaleString()} Wikipedia sitelinks`
  const views = place.wikiViewCount ?? 0
  const thumbnail = place.commonsImageUrls[0]
  const image = thumbnail
    ? `<img class="map-card-image" src="${escapeHtml(thumbnailImageUrl(thumbnail, 384))}" alt="" loading="lazy" decoding="async">`
    : '<div class="map-card-image map-card-image-fallback" aria-hidden="true">🏛</div>'
  return `
    <div class="map-card">
      ${image}
      <div class="map-card-copy">
        <strong>${escapeHtml(place.labelNative)}</strong>
        ${translations ? `<span>${escapeHtml(translations)}</span>` : ''}
        ${designation ? `<span class="map-card-designation">${escapeHtml(designation)}</span>` : ''}
        <span class="map-card-meta">
          <span class="map-card-popularity" title="${escapeHtml(popularityTitle)}">
            <span>Wiki popularity</span>
            <strong>${wikipediaPopularityScore(place.wikipediaSitelinksCount)}</strong>
          </span>
          ${metric === 'views'
            ? `<span class="map-card-views">${formatViews(views)} Wikipedia views</span>`
            : ''}
        </span>
      </div>
    </div>
  `
}

function toBounds(map: L.Map): MapBounds {
  const bounds = map.getBounds()
  const size = map.getSize()
  return {
    south: bounds.getSouth(),
    west: bounds.getWest(),
    north: bounds.getNorth(),
    east: bounds.getEast(),
    zoom: map.getZoom(),
    pixelWidth: size.x,
    pixelHeight: size.y,
  }
}

function bringHighMetricMarkersToFront(
  markers: L.MarkerClusterGroup,
  metricValues: WeakMap<L.Layer, number>,
): void {
  markers.getLayers()
    .sort((first, second) => (metricValues.get(first) ?? 0) - (metricValues.get(second) ?? 0))
    .forEach((layer) => {
      if (layer instanceof L.CircleMarker) layer.bringToFront()
    })
}

export function MapPanel({ places, dataKey, colorMetric, onOpenPlace, onViewportChanged }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markerLayerRef = useRef<L.MarkerClusterGroup | null>(null)
  const legendElementRef = useRef<HTMLDivElement | null>(null)
  const metricRef = useRef<ColorMetric>(colorMetric)
  const markerMetricValuesRef = useRef(new WeakMap<L.Layer, number>())
  const markerPointCountsRef = useRef(new WeakMap<L.Layer, number>())
  const markerLayersRef = useRef(new Map<string, L.Layer>())
  const pendingClusterResetRef = useRef(false)
  const dataKeyRef = useRef(dataKey)
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
    metricRef.current = colorMetric
    const legendElement = legendElementRef.current
    if (legendElement) updateLegend(legendElement, METRIC_CONFIGS[colorMetric])
  }, [colorMetric])

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
      updateLegend(element, METRIC_CONFIGS[metricRef.current])
      legendElementRef.current = element
      return element
    }
    legend.addTo(map)

    const markers = L.markerClusterGroup({
      chunkedLoading: false,
      chunkInterval: 20,
      chunkDelay: 10,
      maxClusterRadius: (zoom) => zoom <= 4 ? 72 : zoom <= 6 ? 60 : 48,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      disableClusteringAtZoom: INDIVIDUAL_MARKER_ZOOM,
      iconCreateFunction: (cluster) => {
        const childMarkers = cluster.getAllChildMarkers()
        const highestValue = childMarkers.reduce(
          (highest, marker) => Math.max(highest, markerMetricValuesRef.current.get(marker) ?? 0),
          0,
        )
        const pointCount = childMarkers.reduce(
          (total, marker) => total + (markerPointCountsRef.current.get(marker) ?? 1),
          0,
        )
        const config = METRIC_CONFIGS[metricRef.current]
        cluster.setZIndexOffset(metricZIndex(highestValue, config.max))
        return countMarkerIcon(pointCount, highestValue, config)
      },
    })
    markers.addTo(map)

    const reportViewport = () => onViewportRef.current(toBounds(map))
    const prepareForZoom = () => { pendingClusterResetRef.current = true }
    const restackMarkers = () => bringHighMetricMarkersToFront(markers, markerMetricValuesRef.current)

    // Pans load additional markers into the existing cluster tree. Zooms mark
    // that tree for replacement before reporting the newly visible viewport.
    map.on('moveend', reportViewport)
    map.on('resize', reportViewport)
    map.on('zoomstart', prepareForZoom)
    map.on('zoomend', restackMarkers)
    mapRef.current = map
    markerLayerRef.current = markers
    reportViewport()

    return () => {
      map.off('moveend', reportViewport)
      map.off('resize', reportViewport)
      map.off('zoomstart', prepareForZoom)
      map.off('zoomend', restackMarkers)
      map.remove()
      mapRef.current = null
      markerLayerRef.current = null
      legendElementRef.current = null
    }
  }, [])

  useEffect(() => {
    const markers = markerLayerRef.current
    const map = mapRef.current
    if (!markers || !map) return

    const dataChanged = dataKeyRef.current !== dataKey
    const aggregatedMode = places.length
      ? places.some((place) => place.mapAggregate)
      : aggregatedModeRef.current
    const modeChanged = aggregatedMode !== aggregatedModeRef.current
    if (pendingClusterResetRef.current || dataChanged || modeChanged) {
      markers.clearLayers()
      markerLayersRef.current.clear()
      pendingClusterResetRef.current = false
      dataKeyRef.current = dataKey
    }

    if (aggregatedMode !== aggregatedModeRef.current) {
      map.removeLayer(markers)
      const options = markers.options as L.MarkerClusterGroupOptions
      options.disableClusteringAtZoom = aggregatedMode ? undefined : INDIVIDUAL_MARKER_ZOOM
      markers.addTo(map)
      aggregatedModeRef.current = aggregatedMode
    }

    const config = METRIC_CONFIGS[colorMetric]
    const placesByMetric = [...places].sort(
      (first, second) => metricValue(first, colorMetric) - metricValue(second, colorMetric),
    )
    const newLayers: L.Layer[] = []

    for (const place of placesByMetric) {
      if (typeof place.latitude !== 'number' || typeof place.longitude !== 'number') continue
      if (markerLayersRef.current.has(place.qid)) continue
      const pointCount = place.mapPointCount ?? 1
      const value = metricValue(place, colorMetric)

      if (place.mapAggregate) {
        const marker = L.marker([place.latitude, place.longitude], {
          icon: countMarkerIcon(pointCount, value, config),
          zIndexOffset: metricZIndex(value, config.max),
        })
        markerMetricValuesRef.current.set(marker, value)
        markerPointCountsRef.current.set(marker, pointCount)
        marker.on('click', () => {
          const map = mapRef.current
          if (map) map.setView(marker.getLatLng(), Math.min(map.getZoom() + 2, map.getMaxZoom()))
        })
        markerLayersRef.current.set(place.qid, marker)
        newLayers.push(marker)
        continue
      }

      const marker = L.circleMarker([place.latitude, place.longitude], {
        radius: 6,
        weight: 1,
        color: '#ffffff',
        fillColor: metricColor(value, config.max),
        fillOpacity: 0.95,
      })
      markerMetricValuesRef.current.set(marker, value)
      markerPointCountsRef.current.set(marker, 1)

      marker.bindTooltip(popupHtml(place, colorMetric), {
        className: 'place-map-tooltip',
        direction: 'top',
        offset: [0, -10],
        opacity: 1,
      })
      marker.bindPopup(popupHtml(place, colorMetric), { closeButton: false, offset: [0, -2] })
      marker.on('click', () => onOpenRef.current(place.qid))
      markerLayersRef.current.set(place.qid, marker)
      newLayers.push(marker)
    }

    if (newLayers.length) {
      markers.addLayers(newLayers)
      bringHighMetricMarkersToFront(markers, markerMetricValuesRef.current)
    }
  }, [places, dataKey, colorMetric])

  return <div ref={containerRef} className="map" aria-label="Interactive heritage map" />
}
