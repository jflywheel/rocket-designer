import { useEffect, useRef, useState, useCallback } from 'react'
import * as THREE from 'three'
import './App.css'

// ─── Design Constants ───
const BODY_RADIUS = 15       // 30mm diameter, universal interface
const RADIAL_SEGMENTS = 52   // smooth enough, fast to export
const NOSE_HEIGHT = 58
const BASE_HEIGHT = 22
const FIN_OVERLAP = 0.8      // fins overlap body so slicer merges them as one solid
const BORE_RADIUS = 8.5      // 17mm diameter bore fits over 1/2" CPVC (16.8mm OD)
const BORE_DEPTH = 15        // 15mm deep socket

// ─── Bambu Basic PLA Palette (4 AMS slots) ───
const BAMBU_COLORS = [
  { name: 'Black', hex: '#000000' },
  { name: 'White', hex: '#FFFFFF' },
  { name: 'Red', hex: '#DA291C' },
  { name: 'Blue', hex: '#0033A0' },
]

const DEFAULT_COLORS = {
  nose: '#DA291C',      // Red
  upperBody: '#FFFFFF',  // White
  lowerBody: '#FFFFFF',  // White
  fins: '#000000',       // Black
  base: '#0033A0',       // Blue
}

// ─── Part Options ───
const NOSE_OPTIONS = ['Ogive', 'Conical', 'Parabolic', 'Elliptical']
const UPPER_BODY_OPTIONS = [
  { label: 'None', height: 0 },
  { label: 'Short (40mm)', height: 40 },
  { label: 'Medium (70mm)', height: 70 },
  { label: 'Long (100mm)', height: 100 },
]
const LOWER_BODY_OPTIONS = [
  { label: 'Short (40mm)', height: 40 },
  { label: 'Medium (70mm)', height: 70 },
  { label: 'Long (100mm)', height: 100 },
]
const FIN_OPTIONS = [
  '3-Fin Delta',
  '4-Fin Delta',
  '3-Fin Swept',
  '4-Fin Straight',
  '6-Fin Swept',
]
const BASE_OPTIONS = ['Standard', 'Boat Tail']

// ─── Geometry Builders ───

// Nose cone profile: array of Vector2 points for LatheGeometry
// t goes 0 (tip) to 1 (base), we build points from tip down
function buildNoseGeometry(type) {
  const points = []
  const R = BODY_RADIUS
  const H = NOSE_HEIGHT
  const segments = 40

  for (let i = 0; i <= segments; i++) {
    const t = i / segments // 0 = tip, 1 = base
    let radius

    switch (type) {
      case 'Ogive': {
        // Tangent ogive: a circular arc tangent to the body at the base
        const rho = (R * R + H * H) / (2 * R)
        const x = t * H
        radius = Math.sqrt(rho * rho - (H - x) * (H - x)) - (rho - R)
        radius = Math.max(0, radius)
        break
      }
      case 'Conical':
        radius = t * R
        break
      case 'Parabolic': {
        const k = 0.75
        radius = R * ((2 * t - k * t * t) / (2 - k))
        break
      }
      case 'Elliptical':
        radius = R * Math.sqrt(1 - (1 - t) * (1 - t))
        break
      default:
        radius = t * R
    }

    // LatheGeometry uses (x=radius, y=height)
    // Build from base (y=0) to tip (y=H), but points array goes tip-first
    points.push(new THREE.Vector2(radius, (1 - t) * H))
  }

  return new THREE.LatheGeometry(points, RADIAL_SEGMENTS)
}

// Simple cylinder for body tubes
function buildTubeGeometry(height) {
  if (height <= 0) return null
  return new THREE.CylinderGeometry(BODY_RADIUS, BODY_RADIUS, height, RADIAL_SEGMENTS)
}

// Base: standard or boat tail, optionally with a launch bore (hollow socket)
// When bore is enabled, we use LatheGeometry with an annular cross-section
function buildBaseGeometry(type, bore = false) {
  const bottomRadius = type === 'Boat Tail' ? BODY_RADIUS * 0.7 : BODY_RADIUS

  if (!bore) {
    return new THREE.CylinderGeometry(BODY_RADIUS, bottomRadius, BASE_HEIGHT, RADIAL_SEGMENTS)
  }

  // Build a cross-section profile that creates a hollow base when revolved.
  // Profile traces the outer wall down, across the bottom ring, up the bore, across the bore lip.
  // LatheGeometry revolves Vector2(x=radius, y=height) around Y axis.
  const H = BASE_HEIGHT
  const points = [
    new THREE.Vector2(BODY_RADIUS, H / 2),          // top outer edge
    new THREE.Vector2(bottomRadius, -H / 2),         // bottom outer edge
    new THREE.Vector2(BORE_RADIUS, -H / 2),          // bottom inner edge (bore opening)
    new THREE.Vector2(BORE_RADIUS, -H / 2 + BORE_DEPTH), // top of bore cavity
    new THREE.Vector2(0.001, -H / 2 + BORE_DEPTH),  // center at bore ceiling (tiny radius to close)
    new THREE.Vector2(0.001, H / 2),                 // center at top
  ]

  return new THREE.LatheGeometry(points, RADIAL_SEGMENTS)
}

// Build a single fin as an extruded 2D shape
function buildSingleFin(style) {
  const shape = new THREE.Shape()
  const rootChord = 35    // length along body
  const tipChord = 15     // length at outer tip
  const span = 25         // how far fin sticks out
  const sweepBack = style.includes('Swept') ? 15 : 0
  const thickness = 2     // fin thickness

  if (style.includes('Delta')) {
    shape.moveTo(0, 0)
    shape.lineTo(rootChord, 0)
    shape.lineTo(rootChord * 0.5 + sweepBack, span)
    shape.closePath()
  } else if (style.includes('Straight')) {
    shape.moveTo(0, 0)
    shape.lineTo(rootChord, 0)
    shape.lineTo(rootChord - (rootChord - tipChord) / 2, span)
    shape.lineTo((rootChord - tipChord) / 2, span)
    shape.closePath()
  } else {
    shape.moveTo(0, 0)
    shape.lineTo(rootChord, 0)
    shape.lineTo(tipChord + sweepBack, span)
    shape.lineTo(sweepBack, span)
    shape.closePath()
  }

  return new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false })
}

// Arrange fins evenly around the body
function buildFinsGroup(style) {
  const finCount = parseInt(style.charAt(0))
  const group = new THREE.Group()

  for (let i = 0; i < finCount; i++) {
    const finGeo = buildSingleFin(style)
    const finMesh = new THREE.Mesh(finGeo)

    // Fin shape: root chord along X, span along Y, extruded along Z.
    // Rotate so root chord runs along rocket Y axis, span points outward radially.
    finMesh.rotation.z = -Math.PI / 2
    finMesh.position.set(BODY_RADIUS - FIN_OVERLAP, 35 / 2, -1) // root at body surface, centered vertically

    // Wrapper rotates around Y to space fins evenly
    const wrapper = new THREE.Group()
    wrapper.add(finMesh)
    wrapper.rotation.y = (i / finCount) * Math.PI * 2
    group.add(wrapper)
  }

  return group
}

// ─── STL Export ───

function writeBinarySTL(geometry) {
  const geo = geometry.index ? geometry.toNonIndexed() : geometry.clone()
  geo.computeVertexNormals()

  const positions = geo.attributes.position.array
  const normals = geo.attributes.normal.array
  const triangleCount = positions.length / 9

  // 80-byte header + 4-byte count + 50 bytes per triangle
  const buffer = new ArrayBuffer(80 + 4 + triangleCount * 50)
  const view = new DataView(buffer)

  // Header (zeros)
  for (let i = 0; i < 80; i++) view.setUint8(i, 0)
  view.setUint32(80, triangleCount, true)

  let offset = 84
  for (let i = 0; i < triangleCount; i++) {
    const idx = i * 9

    // Face normal (average of 3 vertex normals)
    view.setFloat32(offset, (normals[idx] + normals[idx + 3] + normals[idx + 6]) / 3, true)
    view.setFloat32(offset + 4, (normals[idx + 1] + normals[idx + 4] + normals[idx + 7]) / 3, true)
    view.setFloat32(offset + 8, (normals[idx + 2] + normals[idx + 5] + normals[idx + 8]) / 3, true)
    offset += 12

    // 3 vertices
    for (let v = 0; v < 3; v++) {
      view.setFloat32(offset, positions[idx + v * 3], true)
      view.setFloat32(offset + 4, positions[idx + v * 3 + 1], true)
      view.setFloat32(offset + 8, positions[idx + v * 3 + 2], true)
      offset += 12
    }

    view.setUint16(offset, 0, true) // attribute byte count
    offset += 2
  }

  return new Uint8Array(buffer)
}

// ─── ZIP Builder (pure JS, no dependencies) ───

function crc32(data) {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    table[i] = c
  }
  let crc = 0xFFFFFFFF
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function buildZip(files) {
  const localHeaders = []
  const centralHeaders = []
  let offset = 0

  for (const file of files) {
    const nameBytes = new TextEncoder().encode(file.name)
    const crc = crc32(file.data)
    const size = file.data.length

    // Local file header
    const local = new ArrayBuffer(30 + nameBytes.length)
    const lv = new DataView(local)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(8, 0, true)  // no compression
    lv.setUint32(14, crc, true)
    lv.setUint32(18, size, true)
    lv.setUint32(22, size, true)
    lv.setUint16(26, nameBytes.length, true)
    new Uint8Array(local).set(nameBytes, 30)

    localHeaders.push({ header: new Uint8Array(local), data: file.data, offset })

    // Central directory entry
    const central = new ArrayBuffer(46 + nameBytes.length)
    const cv = new DataView(central)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(10, 0, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, size, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    new Uint8Array(central).set(nameBytes, 46)

    centralHeaders.push(new Uint8Array(central))
    offset += 30 + nameBytes.length + size
  }

  const centralDirSize = centralHeaders.reduce((sum, h) => sum + h.length, 0)
  const zipBuffer = new Uint8Array(offset + centralDirSize + 22)
  let pos = 0

  for (const { header, data } of localHeaders) {
    zipBuffer.set(header, pos); pos += header.length
    zipBuffer.set(data, pos); pos += data.length
  }
  for (const header of centralHeaders) {
    zipBuffer.set(header, pos); pos += header.length
  }

  // End of central directory
  const eocd = new ArrayBuffer(22)
  const ev = new DataView(eocd)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, centralDirSize, true)
  ev.setUint32(16, offset, true)
  zipBuffer.set(new Uint8Array(eocd), pos)

  return zipBuffer
}

// ─── 3MF Builder ───
// Builds a 3MF file (ZIP with XML) that Bambu Studio reads with colors pre-assigned.
// Uses per-triangle basematerials so each rocket section gets its color automatically.

function build3MF(sections, colorMap) {
  // sections: { sectionName: [BufferGeometry] }
  // colorMap: { sectionName: '#RRGGBB' }

  // Collect unique colors and assign indices
  const uniqueColors = [...new Set(Object.values(colorMap))]
  const colorIdx = (hex) => uniqueColors.indexOf(hex)

  // Merge all section geometries into one vertex + triangle list
  const vertices = []
  const triangles = []
  let vOffset = 0

  for (const [section, geos] of Object.entries(sections)) {
    const cIdx = colorIdx(colorMap[section])
    for (const geo of geos) {
      const ni = geo.index ? geo.toNonIndexed() : geo
      const pos = ni.attributes.position.array
      const count = pos.length / 3

      for (let i = 0; i < count; i++) {
        vertices.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])
      }
      for (let i = 0; i < count; i += 3) {
        triangles.push(vOffset + i, vOffset + i + 1, vOffset + i + 2, cIdx)
      }
      vOffset += count
    }
  }

  // Build basematerials XML (color definitions)
  const baseMats = uniqueColors.map(hex => {
    const bc = BAMBU_COLORS.find(c => c.hex === hex)
    return `   <base name="${bc ? bc.name : 'Color'}" displaycolor="${hex}FF"/>`
  }).join('\n')

  // Build vertices XML
  const verts = []
  for (let i = 0; i < vertices.length; i += 3) {
    verts.push(`     <vertex x="${vertices[i]}" y="${vertices[i + 1]}" z="${vertices[i + 2]}"/>`)
  }

  // Build triangles XML with per-triangle color (pid=basematerials group, p1=color index)
  const tris = []
  for (let i = 0; i < triangles.length; i += 4) {
    tris.push(`     <triangle v1="${triangles[i]}" v2="${triangles[i + 1]}" v3="${triangles[i + 2]}" pid="1" p1="${triangles[i + 3]}"/>`)
  }

  // Main model XML
  // Transform rotates from Three.js Y-up to 3MF Z-up (90deg around X)
  const modelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US"
  xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources>
  <basematerials id="1">
${baseMats}
  </basematerials>
  <object id="2" type="model" pid="1" pindex="0">
   <mesh>
    <vertices>
${verts.join('\n')}
    </vertices>
    <triangles>
${tris.join('\n')}
    </triangles>
   </mesh>
  </object>
 </resources>
 <build>
  <item objectid="2" transform="1 0 0 0 0 1 0 -1 0 0 0 0"/>
 </build>
</model>`

  // Package metadata files
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`

  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`

  const enc = new TextEncoder()
  return buildZip([
    { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
    { name: '_rels/.rels', data: enc.encode(rels) },
    { name: '3D/3dmodel.model', data: enc.encode(modelXml) },
  ])
}

// ─── Download Helper ───
function downloadBlob(data, filename, mimeType) {
  const blob = new Blob([data], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ─── Main App ───

export default function App() {
  const [noseCone, setNoseCone] = useState('Ogive')
  const [upperBody, setUpperBody] = useState(1)
  const [lowerBody, setLowerBody] = useState(1)
  const [fins, setFins] = useState('3-Fin Delta')
  const [base, setBase] = useState('Standard')
  const [launchBore, setLaunchBore] = useState(false)
  const [colors, setColors] = useState(DEFAULT_COLORS)

  const canvasRef = useRef(null)
  const sceneRef = useRef(null)
  const cameraRef = useRef(null)
  const rendererRef = useRef(null)
  const rocketGroupRef = useRef(null)
  const animFrameRef = useRef(null)
  const isDraggingRef = useRef(false)
  const prevMouseRef = useRef({ x: 0, y: 0 })
  const sphericalRef = useRef({ theta: 0, phi: Math.PI / 3, radius: 200 })
  const autoRotateRef = useRef(true)

  const setColor = useCallback((section, color) => {
    setColors(prev => ({ ...prev, [section]: color }))
  }, [])

  // Assemble the full rocket from all selected parts
  const buildRocket = useCallback(() => {
    const group = new THREE.Group()
    let y = 0

    // Base (with optional launch bore for air pressure launching)
    const baseGeo = buildBaseGeometry(base, launchBore)
    const baseMesh = new THREE.Mesh(baseGeo, new THREE.MeshPhongMaterial({ color: colors.base, side: THREE.DoubleSide }))
    baseMesh.position.y = BASE_HEIGHT / 2
    baseMesh.userData.section = 'base'
    group.add(baseMesh)
    y += BASE_HEIGHT

    // Lower body
    const lowerH = LOWER_BODY_OPTIONS[lowerBody].height
    if (lowerH > 0) {
      const lowerMesh = new THREE.Mesh(
        buildTubeGeometry(lowerH),
        new THREE.MeshPhongMaterial({ color: colors.lowerBody })
      )
      lowerMesh.position.y = y + lowerH / 2
      lowerMesh.userData.section = 'lowerBody'
      group.add(lowerMesh)
    }

    // Fins (centered on lower body)
    const finsGroup = buildFinsGroup(fins)
    finsGroup.position.y = y + lowerH / 2
    finsGroup.traverse(child => {
      if (child.isMesh) {
        child.material = new THREE.MeshPhongMaterial({ color: colors.fins })
        child.userData.section = 'fins'
      }
    })
    group.add(finsGroup)
    y += lowerH

    // Upper body (optional)
    const upperH = UPPER_BODY_OPTIONS[upperBody].height
    if (upperH > 0) {
      const upperMesh = new THREE.Mesh(
        buildTubeGeometry(upperH),
        new THREE.MeshPhongMaterial({ color: colors.upperBody })
      )
      upperMesh.position.y = y + upperH / 2
      upperMesh.userData.section = 'upperBody'
      group.add(upperMesh)
      y += upperH
    }

    // Nose cone
    const noseMesh = new THREE.Mesh(
      buildNoseGeometry(noseCone),
      new THREE.MeshPhongMaterial({ color: colors.nose })
    )
    noseMesh.position.y = y
    noseMesh.userData.section = 'nose'
    group.add(noseMesh)

    // Center vertically
    group.position.y = -(y + NOSE_HEIGHT) / 2

    return group
  }, [noseCone, upperBody, lowerBody, fins, base, launchBore, colors])

  // Set up Three.js scene once
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x1a1a2e)
    sceneRef.current = scene

    const camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.1, 1000)
    cameraRef.current = camera

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    renderer.setSize(canvas.clientWidth, canvas.clientHeight)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    rendererRef.current = renderer

    // Lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.4))
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8)
    dirLight.position.set(50, 100, 50)
    scene.add(dirLight)
    const backLight = new THREE.DirectionalLight(0xffffff, 0.3)
    backLight.position.set(-50, -50, -50)
    scene.add(backLight)

    // Reference grid
    const grid = new THREE.GridHelper(200, 20, 0x333355, 0x222244)
    grid.position.y = -100
    scene.add(grid)

    // Resize handling
    const ro = new ResizeObserver(() => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    })
    ro.observe(canvas.parentElement)

    // Manual orbit controls
    const onMouseDown = (e) => {
      isDraggingRef.current = true
      prevMouseRef.current = { x: e.clientX, y: e.clientY }
      autoRotateRef.current = false
    }
    const onMouseMove = (e) => {
      if (!isDraggingRef.current) return
      const dx = e.clientX - prevMouseRef.current.x
      const dy = e.clientY - prevMouseRef.current.y
      prevMouseRef.current = { x: e.clientX, y: e.clientY }
      sphericalRef.current.theta -= dx * 0.01
      sphericalRef.current.phi = Math.max(0.1, Math.min(Math.PI - 0.1, sphericalRef.current.phi + dy * 0.01))
    }
    const onMouseUp = () => { isDraggingRef.current = false }
    const onWheel = (e) => {
      e.preventDefault()
      sphericalRef.current.radius = Math.max(80, Math.min(500, sphericalRef.current.radius + e.deltaY * 0.3))
    }

    // Touch support
    const onTouchStart = (e) => {
      if (e.touches.length === 1) {
        isDraggingRef.current = true
        prevMouseRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
        autoRotateRef.current = false
      }
    }
    const onTouchMove = (e) => {
      if (!isDraggingRef.current || e.touches.length !== 1) return
      const dx = e.touches[0].clientX - prevMouseRef.current.x
      const dy = e.touches[0].clientY - prevMouseRef.current.y
      prevMouseRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      sphericalRef.current.theta -= dx * 0.01
      sphericalRef.current.phi = Math.max(0.1, Math.min(Math.PI - 0.1, sphericalRef.current.phi + dy * 0.01))
    }
    const onTouchEnd = () => { isDraggingRef.current = false }

    canvas.addEventListener('mousedown', onMouseDown)
    canvas.addEventListener('mousemove', onMouseMove)
    canvas.addEventListener('mouseup', onMouseUp)
    canvas.addEventListener('mouseleave', onMouseUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('touchstart', onTouchStart, { passive: true })
    canvas.addEventListener('touchmove', onTouchMove, { passive: true })
    canvas.addEventListener('touchend', onTouchEnd)

    // Render loop
    const animate = () => {
      animFrameRef.current = requestAnimationFrame(animate)
      if (autoRotateRef.current) sphericalRef.current.theta += 0.005
      const { theta, phi, radius } = sphericalRef.current
      camera.position.set(
        radius * Math.sin(phi) * Math.sin(theta),
        radius * Math.cos(phi),
        radius * Math.sin(phi) * Math.cos(theta)
      )
      camera.lookAt(0, 0, 0)
      renderer.render(scene, camera)
    }
    animate()

    return () => {
      cancelAnimationFrame(animFrameRef.current)
      ro.disconnect()
      canvas.removeEventListener('mousedown', onMouseDown)
      canvas.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('mouseup', onMouseUp)
      canvas.removeEventListener('mouseleave', onMouseUp)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('touchstart', onTouchStart)
      canvas.removeEventListener('touchmove', onTouchMove)
      canvas.removeEventListener('touchend', onTouchEnd)
      renderer.dispose()
    }
  }, [])

  // Rebuild rocket whenever design changes
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return

    // Clean up old rocket
    if (rocketGroupRef.current) {
      scene.remove(rocketGroupRef.current)
      rocketGroupRef.current.traverse(child => {
        if (child.isMesh) {
          child.geometry.dispose()
          child.material.dispose()
        }
      })
    }

    const group = buildRocket()
    rocketGroupRef.current = group
    scene.add(group)
  }, [buildRocket])

  // ─── Export Helpers ───

  // Collect all geometries by section with world transforms baked in
  const getExportGeometries = useCallback(() => {
    const sections = {}
    const group = rocketGroupRef.current
    if (!group) return sections

    group.updateMatrixWorld(true)
    group.traverse(child => {
      if (child.isMesh && child.userData.section) {
        const geo = child.geometry.clone()
        geo.applyMatrix4(child.matrixWorld)
        const s = child.userData.section
        if (!sections[s]) sections[s] = []
        sections[s].push(geo)
      }
    })
    return sections
  }, [])

  // Merge an array of BufferGeometries into one
  const mergeGeometries = useCallback((geos) => {
    if (geos.length === 0) return null
    if (geos.length === 1) {
      const g = geos[0].index ? geos[0].toNonIndexed() : geos[0]
      g.computeVertexNormals()
      return g
    }

    let totalVerts = 0
    const nonIndexed = geos.map(g => {
      const ni = g.index ? g.toNonIndexed() : g
      totalVerts += ni.attributes.position.count
      return ni
    })

    const merged = new Float32Array(totalVerts * 3)
    let off = 0
    for (const g of nonIndexed) {
      merged.set(g.attributes.position.array, off)
      off += g.attributes.position.array.length
    }

    const result = new THREE.BufferGeometry()
    result.setAttribute('position', new THREE.BufferAttribute(merged, 3))
    result.computeVertexNormals()
    return result
  }, [])

  const handleExportSingle = useCallback(() => {
    const sections = getExportGeometries()
    const allGeos = Object.values(sections).flat()
    const merged = mergeGeometries(allGeos)
    if (!merged) return
    downloadBlob(writeBinarySTL(merged), 'rocket.stl', 'application/octet-stream')
    merged.dispose()
  }, [getExportGeometries, mergeGeometries])

  const handleExportZip = useCallback(() => {
    const sections = getExportGeometries()
    const files = []

    const sectionLabels = {
      nose: `Nose Cone (${noseCone})`,
      upperBody: `Upper Body (${UPPER_BODY_OPTIONS[upperBody].label})`,
      lowerBody: `Lower Body (${LOWER_BODY_OPTIONS[lowerBody].label})`,
      fins: `Fins (${fins})`,
      base: `Base (${base})`,
    }

    let readme = 'ROCKET DESIGNER: AMS Color Assignment\n'
    readme += '======================================\n\n'
    readme += 'Load each STL in Bambu Studio and assign colors:\n\n'

    let slot = 1
    for (const [section, geos] of Object.entries(sections)) {
      const merged = mergeGeometries(geos)
      if (!merged) continue
      const filename = `rocket_${section}.stl`
      files.push({ name: filename, data: writeBinarySTL(merged) })
      readme += `AMS Slot ${slot}: ${filename}\n`
      readme += `  Section: ${sectionLabels[section] || section}\n`
      readme += `  Color: ${colors[section]}\n\n`
      slot++
      merged.dispose()
    }

    readme += '\nDesign Settings\n'
    readme += '---------------\n'
    readme += `Nose Cone: ${noseCone}\n`
    readme += `Upper Body: ${UPPER_BODY_OPTIONS[upperBody].label}\n`
    readme += `Lower Body: ${LOWER_BODY_OPTIONS[lowerBody].label}\n`
    readme += `Fins: ${fins}\n`
    readme += `Base: ${base}\n`
    readme += `Launch Bore: ${launchBore ? 'Yes (17mm, fits 1/2" CPVC)' : 'No (solid)'}\n`
    readme += `\nBody Diameter: 30mm\n`
    readme += `Print as solid, no supports needed.\n`
    readme += `Bambu Studio merges overlapping fin geometry automatically.\n`

    files.push({ name: 'README.txt', data: new TextEncoder().encode(readme) })
    downloadBlob(buildZip(files), 'rocket_design.zip', 'application/zip')
  }, [getExportGeometries, mergeGeometries, noseCone, upperBody, lowerBody, fins, base, launchBore, colors])

  const handleExport3MF = useCallback(() => {
    const sections = getExportGeometries()
    const data = build3MF(sections, colors)
    downloadBlob(data, 'rocket.3mf', 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml')
  }, [getExportGeometries, colors])

  const totalHeight = BASE_HEIGHT + LOWER_BODY_OPTIONS[lowerBody].height + UPPER_BODY_OPTIONS[upperBody].height + NOSE_HEIGHT

  return (
    <div className="app">
      <div className="panel">
        <h1 className="title">Rocket Designer</h1>
        <p className="subtitle">Design and export STL files for 3D printing</p>

        {/* Nose Cone */}
        <Section label="Nose Cone" color={colors.nose} onColor={c => setColor('nose', c)}>
          <OptionGrid options={NOSE_OPTIONS} value={noseCone} onChange={setNoseCone} />
        </Section>

        {/* Upper Body */}
        <Section label="Upper Body" color={colors.upperBody} onColor={c => setColor('upperBody', c)}>
          <OptionGrid
            options={UPPER_BODY_OPTIONS.map(o => o.label)}
            value={UPPER_BODY_OPTIONS[upperBody].label}
            onChange={label => setUpperBody(UPPER_BODY_OPTIONS.findIndex(o => o.label === label))}
          />
        </Section>

        {/* Lower Body */}
        <Section label="Lower Body" color={colors.lowerBody} onColor={c => setColor('lowerBody', c)}>
          <OptionGrid
            options={LOWER_BODY_OPTIONS.map(o => o.label)}
            value={LOWER_BODY_OPTIONS[lowerBody].label}
            onChange={label => setLowerBody(LOWER_BODY_OPTIONS.findIndex(o => o.label === label))}
          />
        </Section>

        {/* Fins */}
        <Section label="Fins" color={colors.fins} onColor={c => setColor('fins', c)}>
          <OptionGrid options={FIN_OPTIONS} value={fins} onChange={setFins} />
        </Section>

        {/* Base */}
        <Section label="Base" color={colors.base} onColor={c => setColor('base', c)}>
          <OptionGrid options={BASE_OPTIONS} value={base} onChange={setBase} />
          <label className="toggle">
            <input type="checkbox" checked={launchBore} onChange={e => setLaunchBore(e.target.checked)} />
            <span>Launch Bore</span>
            <span className="toggle-hint">17mm socket for 1/2" CPVC launch tube</span>
          </label>
        </Section>

        <div className="stats">
          <span>Height: {totalHeight}mm</span>
          <span>Diameter: 30mm</span>
        </div>

        <div className="export-section">
          <button className="export-btn" onClick={handleExport3MF}>
            Export 3MF (Multi-Color)
          </button>
          <button className="export-btn export-alt" onClick={handleExportSingle}>
            Export Single STL
          </button>
        </div>

        <p className="hint">Drag to orbit. Scroll to zoom. Prints as one solid piece.</p>
      </div>

      <div className="viewport">
        <canvas ref={canvasRef} />
      </div>
    </div>
  )
}

// ─── Small Reusable Components ───

function Section({ label, color, onColor, children }) {
  return (
    <div className="section">
      <div className="section-header">
        <label>{label}</label>
        <div className="color-swatches">
          {BAMBU_COLORS.map(bc => (
            <button
              key={bc.hex}
              className={`swatch ${color === bc.hex ? 'active' : ''}`}
              style={{ background: bc.hex }}
              onClick={() => onColor(bc.hex)}
              title={bc.name}
            />
          ))}
        </div>
      </div>
      {children}
    </div>
  )
}

function OptionGrid({ options, value, onChange }) {
  return (
    <div className="option-grid">
      {options.map(opt => (
        <button
          key={opt}
          className={`option-btn ${value === opt ? 'active' : ''}`}
          onClick={() => onChange(opt)}
        >
          {opt}
        </button>
      ))}
    </div>
  )
}
