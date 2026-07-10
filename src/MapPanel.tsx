import { useCallback, useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {
  COUNTRY_CLUSTER_CONTENT,
  countryClusterContent,
  countryClusterKey,
  type CountryClusterContent,
} from './countryClusters'
import { countryFlags, localizedCountryLabel } from './countryFlags'
import { formatViews } from './data'
import { fullResolutionImageUrl, thumbnailImageUrl } from './images'
import { COUNTRY_CLUSTER_MAX_ZOOM, INDIVIDUAL_MARKER_ZOOM } from './mapConfig'
import type { MapBounds, Place, SiteLanguage } from './types'

// Suitable for local development and a very small public demo. Before public
// launch, change this to a tile provider whose terms cover your traffic level.
const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
const VIEW_COUNT_MAX = 10_000_000
const VIEW_COUNT_COLORS = ['#462525', '#874a99', '#613dff', '#00a2ff', '#00f7ff'] as const
const SITELINK_COUNT_MAX = 100
const FOCUS_MARKER_ZOOM = 12
const CLUSTER_ICON_SIZE = 32
const COUNTRY_ICON_WIDTH = 56
const COUNTRY_ICON_HEIGHT = 56
const COUNTRY_FLAG_CENTER_Y = 17

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
    title: 'Wikipedia popularity',
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
  wikiPopularityLabel: string
  language: SiteLanguage
  focusRequest: MapFocusRequest | null
  onOpenPlace: (qid: string) => void
  onViewportChanged: (bounds: MapBounds) => void
}

export type MapFocusRequest = {
  qid: string
  latitude: number
  longitude: number
  requestId: number
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function localizedCountryName(country: string, language: SiteLanguage): string {
  return localizedCountryLabel(country, language).split(' | ')[0] ?? country
}

function normalizedMetricValue(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || value <= 0 || max <= 1) return 0
  return Math.min(1, Math.max(0, Math.log10(value) / Math.log10(max)))
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
    className: 'view-count-cluster',
    html: `<span style="--cluster-color: ${color}; --cluster-text-color: ${textColor}" title="${formattedCount} places; highest has ${config.format(highestValue)} ${config.noun}">${formattedCount}</span>`,
    iconSize: L.point(CLUSTER_ICON_SIZE, CLUSTER_ICON_SIZE),
  })
}

function countryMarkerIcon(
  countryLabel: string,
  pointCount: number,
  highestValue: number,
  config: MetricConfig,
  language: SiteLanguage,
  placeholder = false,
): L.DivIcon | undefined {
  const flag = countryFlags(countryLabel)[0]
  if (!flag) return undefined

  const formattedCount = placeholder ? (language === 'zh' ? '暂无数据' : 'No data') : pointCount.toLocaleString()
  const color = placeholder ? '#64748b' : metricColor(highestValue, config.max)
  const textColor = placeholder ? '#ffffff' : metricTextColor(highestValue, config.max)
  const countryName = localizedCountryName(countryLabel, language)
  const title = placeholder
    ? (language === 'zh' ? `${countryName}：暂无数据` : `${countryName}: no data yet`)
    : (language === 'zh' ? `${countryName}：${formattedCount} 个地点` : `${countryName}: ${formattedCount} places`)
  return L.divIcon({
    className: `country-flag-cluster${placeholder ? ' country-flag-cluster-placeholder' : ''}`,
    html: `<span style="--cluster-color: ${color}; --cluster-text-color: ${textColor}" title="${escapeHtml(title)}"><img src="https://flagcdn.com/${flag.code.toLowerCase()}.svg" alt="" loading="lazy" referrerpolicy="no-referrer"><strong>${formattedCount}</strong></span>`,
    iconSize: L.point(COUNTRY_ICON_WIDTH, COUNTRY_ICON_HEIGHT),
    iconAnchor: L.point(COUNTRY_ICON_WIDTH / 2, COUNTRY_FLAG_CENTER_Y),
  })
}

function markdownInlineHtml(value: string): string {
  const tokens = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*/g
  let html = ''
  let cursor = 0

  for (const match of value.matchAll(tokens)) {
    const index = match.index ?? 0
    html += escapeHtml(value.slice(cursor, index))
    if (match[1] && match[2]) {
      html += `<a href="${escapeHtml(match[2])}" target="_blank" rel="noreferrer">${escapeHtml(match[1])}</a>`
    } else if (match[3]) {
      html += `<strong>${escapeHtml(match[3])}</strong>`
    } else if (match[4]) {
      html += `<code>${escapeHtml(match[4])}</code>`
    } else if (match[5]) {
      html += `<em>${escapeHtml(match[5])}</em>`
    }
    cursor = index + match[0].length
  }

  return html + escapeHtml(value.slice(cursor))
}

function markdownToHtml(source: string): string {
  const lines = source
    .replace(/<!--[^]*?-->/g, '')
    .replace(/\r\n/g, '\n')
    .trim()
    .split('\n')
  if (lines.length === 1 && !lines[0]) return ''

  const blocks: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]?.trim() ?? ''
    if (!line) {
      index += 1
      continue
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/)
    if (heading?.[1] && heading[2]) {
      const level = heading[1].length + 2
      blocks.push(`<h${level}>${markdownInlineHtml(heading[2])}</h${level}>`)
      index += 1
      continue
    }

    const unordered = line.match(/^[-*]\s+(.+)$/)
    if (unordered) {
      const items: string[] = []
      while (index < lines.length) {
        const item = lines[index]?.trim().match(/^[-*]\s+(.+)$/)
        if (!item?.[1]) break
        items.push(`<li>${markdownInlineHtml(item[1])}</li>`)
        index += 1
      }
      blocks.push(`<ul>${items.join('')}</ul>`)
      continue
    }

    const ordered = line.match(/^\d+\.\s+(.+)$/)
    if (ordered) {
      const items: string[] = []
      while (index < lines.length) {
        const item = lines[index]?.trim().match(/^\d+\.\s+(.+)$/)
        if (!item?.[1]) break
        items.push(`<li>${markdownInlineHtml(item[1])}</li>`)
        index += 1
      }
      blocks.push(`<ol>${items.join('')}</ol>`)
      continue
    }

    const paragraph: string[] = []
    while (index < lines.length) {
      const value = lines[index]?.trim() ?? ''
      if (!value || /^(#{1,3})\s+/.test(value) || /^[-*]\s+/.test(value) || /^\d+\.\s+/.test(value)) break
      paragraph.push(value)
      index += 1
    }
    blocks.push(`<p>${markdownInlineHtml(paragraph.join(' '))}</p>`)
  }

  return blocks.join('')
}

function countryPopupHtml(
  country: string,
  pointCount: number,
  placeholder: boolean,
  language: SiteLanguage,
  content?: CountryClusterContent,
): string {
  const flag = countryFlags(country)[0]
  const markdown = content?.markdown ? markdownToHtml(content.markdown) : ''
  const countryName = localizedCountryName(country, language)
  const subtitle = placeholder
    ? (language === 'zh' ? '暂无数据' : 'Coverage placeholder')
    : (language === 'zh' ? `${pointCount.toLocaleString()} 个地点` : `${pointCount.toLocaleString()} places`)

  return `
    <article class="country-map-card">
      <header>
        ${flag ? `<img src="https://flagcdn.com/${flag.code.toLowerCase()}.svg" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
        <span><strong>${escapeHtml(countryName)}</strong><small>${subtitle}</small></span>
      </header>
      ${markdown ? `<section class="country-map-card-markdown">${markdown}</section>` : ''}
    </article>
  `
}

function bindCountryPopup(
  marker: L.Marker,
  country: string,
  pointCount: number,
  placeholder: boolean,
  language: SiteLanguage,
  content?: CountryClusterContent,
): void {
  let closeTimer: number | undefined
  let wiredElement: HTMLElement | null = null
  const cancelClose = () => {
    if (closeTimer !== undefined) window.clearTimeout(closeTimer)
    closeTimer = undefined
  }
  const closeSoon = () => {
    cancelClose()
    closeTimer = window.setTimeout(() => marker.closePopup(), 140)
  }
  const open = () => {
    cancelClose()
    marker.openPopup()
  }

  marker.bindPopup(countryPopupHtml(country, pointCount, placeholder, language, content), {
    className: 'country-cluster-popup',
    closeButton: false,
    autoPan: false,
    offset: L.point(0, -22),
  })
  marker.on('mouseover', open)
  marker.on('mouseout', closeSoon)
  marker.on('popupopen', () => {
    const element = marker.getPopup()?.getElement() ?? null
    if (!element || element === wiredElement) return
    wiredElement = element
    element.addEventListener('mouseenter', cancelClose)
    element.addEventListener('mouseleave', closeSoon)
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

function popupHtml(place: Place, metric: ColorMetric, wikiPopularityLabel: string): string {
  const translations = [place.labelEn, place.labelZh].filter(Boolean).join(' · ')
  const designations = place.designations.map((item) => `<span>${escapeHtml(item)}</span>`).join('')
  const popularityTitle = `${place.wikipediaSitelinksCount.toLocaleString()} Wikipedia popularity`
  const views = place.wikiViewCount ?? 0
  const thumbnail = place.commonsImageUrls[0]
  const image = thumbnail
    ? `<img class="map-card-image" src="${escapeHtml(thumbnailImageUrl(thumbnail, 384))}" data-original-src="${escapeHtml(fullResolutionImageUrl(thumbnail))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src=this.dataset.originalSrc">`
    : '<div class="map-card-image map-card-image-fallback" aria-hidden="true">🏛</div>'
  return `
    <div class="map-card">
      ${image}
      <div class="map-card-copy">
        <strong>${escapeHtml(place.labelNative)}</strong>
        ${translations ? `<span>${escapeHtml(translations)}</span>` : ''}
        ${designations ? `<span class="map-card-designations">${designations}</span>` : ''}
        <span class="map-card-meta">
          <span class="map-card-popularity" title="${escapeHtml(popularityTitle)}">
            <span>${escapeHtml(wikiPopularityLabel)}</span>
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

export function MapPanel({ places, dataKey, colorMetric, wikiPopularityLabel, language, focusRequest, onOpenPlace, onViewportChanged }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markerLayerRef = useRef<L.LayerGroup | null>(null)
  const legendElementRef = useRef<HTMLDivElement | null>(null)
  const metricRef = useRef<ColorMetric>(colorMetric)
  const markerLayersRef = useRef(new Map<string, L.Layer>())
  const pendingFocusRef = useRef<MapFocusRequest | null>(null)
  const dataKeyRef = useRef(`${dataKey}\u0000${wikiPopularityLabel}\u0000${language}`)
  const onOpenRef = useRef(onOpenPlace)
  const onViewportRef = useRef(onViewportChanged)

  const revealFocusedMarker = useCallback(() => {
    const request = pendingFocusRef.current
    if (!request) return
    const layer = markerLayersRef.current.get(request.qid)
    if (!(layer instanceof L.CircleMarker)) return
    layer.bringToFront()
    layer.openTooltip()
    pendingFocusRef.current = null
  }, [])

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

    const markers = L.layerGroup()
    // Lower zooms arrive pre-aggregated from AtlasDatabase. Keeping one plain
    // canvas-backed layer avoids building a second, conflicting cluster tree.
    markers.addTo(map)

    const reportViewport = () => {
      onViewportRef.current(toBounds(map))
      revealFocusedMarker()
    }
    map.on('moveend', reportViewport)
    map.on('resize', reportViewport)
    mapRef.current = map
    markerLayerRef.current = markers
    reportViewport()

    return () => {
      map.off('moveend', reportViewport)
      map.off('resize', reportViewport)
      map.remove()
      mapRef.current = null
      markerLayerRef.current = null
      markerLayersRef.current.clear()
      legendElementRef.current = null
    }
  }, [revealFocusedMarker])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !focusRequest) return
    pendingFocusRef.current = focusRequest
    map.setView(
      [focusRequest.latitude, focusRequest.longitude],
      Math.max(map.getZoom(), FOCUS_MARKER_ZOOM),
      { animate: false },
    )
  }, [focusRequest])

  useEffect(() => {
    const markers = markerLayerRef.current
    const map = mapRef.current
    if (!markers || !map) return

    const localizedDataKey = `${dataKey}\u0000${wikiPopularityLabel}\u0000${language}`
    const dataChanged = dataKeyRef.current !== localizedDataKey
    if (dataChanged) {
      markers.clearLayers()
      markerLayersRef.current.clear()
      dataKeyRef.current = localizedDataKey
    }

    const showsIndividualMarkers = map.getZoom() >= INDIVIDUAL_MARKER_ZOOM
    const showsCountryClusters = map.getZoom() <= COUNTRY_CLUSTER_MAX_ZOOM
    const realCountries = new Set(
      places
        .filter((place) => place.mapAggregate && place.countryLabelEn)
        .map((place) => countryClusterKey(place.countryLabelEn!)),
    )
    const placeholders = showsCountryClusters
      ? COUNTRY_CLUSTER_CONTENT.filter((content) => (
          content.placeholderCoordinates && !realCountries.has(countryClusterKey(content.country))
        ))
      : []
    const visibleQids = new Set<string>()
    for (const place of places) {
      if ((place.mapAggregate || showsIndividualMarkers)
        && typeof place.latitude === 'number' && typeof place.longitude === 'number') {
        visibleQids.add(place.qid)
      }
    }
    for (const content of placeholders) visibleQids.add(`map-country-placeholder-${countryClusterKey(content.country)}`)
    for (const [qid, layer] of markerLayersRef.current) {
      if (visibleQids.has(qid)) continue
      markers.removeLayer(layer)
      markerLayersRef.current.delete(qid)
    }

    const config = METRIC_CONFIGS[colorMetric]
    const placesByMetric = [...places].sort(
      (first, second) => metricValue(first, colorMetric) - metricValue(second, colorMetric),
    )
    const newLayers: L.Layer[] = []

    for (const place of placesByMetric) {
      if (!place.mapAggregate && !showsIndividualMarkers) continue
      if (typeof place.latitude !== 'number' || typeof place.longitude !== 'number') continue
      if (markerLayersRef.current.has(place.qid)) continue
      const pointCount = place.mapPointCount ?? 1
      const value = metricValue(place, colorMetric)

      if (place.mapAggregate) {
        const countryContent = place.countryLabelEn ? countryClusterContent(place.countryLabelEn, language) : undefined
        const icon = place.countryLabelEn
          ? countryMarkerIcon(place.countryLabelEn, pointCount, value, config, language)
          : undefined
        const marker = L.marker([place.latitude, place.longitude], {
          icon: icon ?? countMarkerIcon(pointCount, value, config),
          zIndexOffset: metricZIndex(value, config.max),
          riseOnHover: Boolean(icon),
          riseOffset: 100_000,
        })
        marker.on('click', () => {
          const map = mapRef.current
          if (map) map.setView(marker.getLatLng(), Math.min(map.getZoom() + 2, map.getMaxZoom()))
        })
        if (place.countryLabelEn) bindCountryPopup(marker, place.countryLabelEn, pointCount, false, language, countryContent)
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
      marker.bindTooltip(() => popupHtml(place, colorMetric, wikiPopularityLabel), {
        className: 'place-map-tooltip',
        direction: 'top',
        offset: [0, -10],
        opacity: 1,
      })
      marker.on('click', () => onOpenRef.current(place.qid))
      markerLayersRef.current.set(place.qid, marker)
      newLayers.push(marker)
    }

    for (const content of placeholders) {
      const coordinates = content.placeholderCoordinates!
      const qid = `map-country-placeholder-${countryClusterKey(content.country)}`
      if (markerLayersRef.current.has(qid)) continue
      const icon = countryMarkerIcon(content.country, 0, 0, config, language, true)
      if (!icon) continue
      const marker = L.marker([coordinates.latitude, coordinates.longitude], {
        icon,
        zIndexOffset: -1,
        riseOnHover: true,
        riseOffset: 100_000,
      })
      bindCountryPopup(marker, content.country, 0, true, language, countryClusterContent(content.country, language))
      marker.on('click', () => {
        const currentMap = mapRef.current
        if (currentMap) currentMap.setView(marker.getLatLng(), Math.min(currentMap.getZoom() + 2, currentMap.getMaxZoom()))
      })
      markerLayersRef.current.set(qid, marker)
      newLayers.push(marker)
    }

    if (newLayers.length) {
      newLayers.forEach((layer) => markers.addLayer(layer))
    }
    revealFocusedMarker()
  }, [places, dataKey, colorMetric, wikiPopularityLabel, language, revealFocusedMarker])

  return <div ref={containerRef} className="map" aria-label="Interactive heritage map" />
}
