import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ---- device ----

// phones and tablets: lower pixel ratio and cheaper bloom
const isPhone = matchMedia( '(max-width: 700px), (pointer: coarse)' ).matches;
// matches the CSS breakpoint where the panel becomes a bottom sheet
const sheetLayout = matchMedia( '(max-width: 700px)' );
const reducedMotion = matchMedia( '(prefers-reduced-motion: reduce)' );
const isPortrait = () => window.innerHeight > window.innerWidth;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera( 75, window.innerWidth / window.innerHeight, 0.1, 1000 );

const renderer = new THREE.WebGLRenderer( { antialias: true } );
renderer.setPixelRatio( Math.min( window.devicePixelRatio, isPhone ? 1.5 : 2 ) );
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.toneMapping = THREE.ACESFilmicToneMapping;
console.log( "three.js revision", THREE.REVISION );
document.body.appendChild( renderer.domElement );

// ---- night environment map (reflections) ----
// a tiny scene that's never shown: dark sky plus a few bright panels,
// so metal, glass and the wet street pick up glints of the lanterns

function buildNightEnvironment() {
    const envScene = new THREE.Scene();

    // sky: near-black blue on top, dim haze at the horizon, near-black below
    const skyGeometry = new THREE.SphereGeometry( 50, 32, 16 );
    const top = new THREE.Color( 0x03060f );
    const horizon = new THREE.Color( 0x0c1424 );
    const bottom = new THREE.Color( 0x010203 );
    const colors = [];
    const c = new THREE.Color();
    const positions = skyGeometry.attributes.position;
    for ( let i = 0; i < positions.count; i++ ) {
        const y = positions.getY( i ) / 50; // -1 at the bottom, 1 at the top
        if ( y > 0 ) c.lerpColors( horizon, top, y );
        else c.lerpColors( horizon, bottom, -y );
        colors.push( c.r, c.g, c.b );
    }
    skyGeometry.setAttribute( 'color', new THREE.Float32BufferAttribute( colors, 3 ) );
    envScene.add( new THREE.Mesh( skyGeometry,
        new THREE.MeshBasicMaterial( { vertexColors: true, side: THREE.BackSide } ) ) );

    // light panels, colours pushed above 1 so they act like light sources
    const panels = [
        { color: 0xff7a33, brightness: 5,   position: [ 5, 2, 9 ],    size: [ 5, 2.5 ] },  // lantern glow
        { color: 0xff6a2a, brightness: 3.5, position: [ -7, 2.5, 6 ], size: [ 4, 2 ] },    // second lantern glow
        { color: 0xe6eeff, brightness: 4,   position: [ 0, 10, -14 ], size: [ 34, 1.6 ] }, // train windows
        { color: 0xbcd0ff, brightness: 2.5, position: [ 14, 7, 2 ],   size: [ 2, 1 ] },    // street lamp
        { color: 0x59b6ff, brightness: 2,   position: [ -14, 5, 2 ],  size: [ 1.2, 4 ] },  // blue sign
    ];
    for ( const panel of panels ) {
        const material = new THREE.MeshBasicMaterial( { side: THREE.DoubleSide } );
        material.color.set( panel.color ).multiplyScalar( panel.brightness );
        const mesh = new THREE.Mesh( new THREE.PlaneGeometry( ...panel.size ), material );
        mesh.position.fromArray( panel.position );
        mesh.lookAt( 0, 0, 0 );
        envScene.add( mesh );
    }

    const pmrem = new THREE.PMREMGenerator( renderer );
    const envMap = pmrem.fromScene( envScene, 0.02 ).texture;
    pmrem.dispose();
    envScene.traverse( ( object ) => {
        if ( object.isMesh ) {
            object.geometry.dispose();
            object.material.dispose();
        }
    } );
    return envMap;
}

scene.environment = buildNightEnvironment();
scene.environmentIntensity = 0.55;

// ---- bloom (the glow) ----
// half-float keeps values above 1 so the bloom can find them;
// samples: 4 brings antialiasing back, since antialias: true doesn't apply inside a composer
const renderTarget = new THREE.WebGLRenderTarget( window.innerWidth, window.innerHeight, {
    type: THREE.HalfFloatType,
    samples: 4,
} );
const composer = new EffectComposer( renderer, renderTarget );
composer.addPass( new RenderPass( scene, camera ) );
// high threshold: only things brighter than white glow, so the walls don't haze over
const bloomPass = new UnrealBloomPass( new THREE.Vector2( window.innerWidth, window.innerHeight ), 0.42, 0.38, 1.15 );
if ( isPhone ) {
    // bloom is the most expensive part; run it at half resolution on phones
    const setBloomSize = bloomPass.setSize.bind( bloomPass );
    bloomPass.setSize = ( width, height ) => setBloomSize( width / 2, height / 2 );
}
composer.addPass( bloomPass );
// must be last: applies tone mapping and colour conversion
composer.addPass( new OutputPass() );
composer.setPixelRatio( renderer.getPixelRatio() );
composer.setSize( window.innerWidth, window.innerHeight );

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// ---- loading screen ----

const loaderScreen = document.getElementById( 'loader' );
const loaderBar = loaderScreen.querySelector( '.bar' );
const loaderFill = loaderScreen.querySelector( '.bar-fill' );
const loaderText = loaderScreen.querySelector( 'p' );

function onProgress( event ) {
    // some hosts compress files and don't send their size; then total is 0
    if ( event.total > 0 ) {
        loaderBar.classList.remove( 'indeterminate' );
        loaderFill.style.width = `${ ( event.loaded / event.total ) * 100 }%`;
    } else {
        loaderBar.classList.add( 'indeterminate' );
    }
}

function hideLoader() {
    loaderFill.style.width = '100%';
    loaderScreen.classList.add( 'done' );
}

let model;
let view;
let mixer;
const actions = {}; // keyed by clip name: train_outer, crowd_life, ...
const timer = new THREE.Timer();
// ignore the time the tab was hidden, so nothing jumps when you come back
timer.connect( document );

const loader = new GLTFLoader();
// menya-arif.glb uses EXT_meshopt_compression, so the loader needs a decoder
loader.setMeshoptDecoder( MeshoptDecoder );

loader.load( 'menya-arif.glb', function ( glb ) {

    console.log(glb);
    model = glb.scene;
    scene.add( model );

    // trains, lanterns, chef, crowd, walkers, petals
    mixer = new THREE.AnimationMixer( model );
    for ( const clip of glb.animations ) {
        actions[ clip.name ] = mixer.clipAction( clip );
        actions[ clip.name ].play();
    }

    // night background, fog and camera limits are stored on the model, not on our scene
    view = model.userData.view;
    scene.background = new THREE.Color( view.background );
    scene.fog = new THREE.FogExp2( view.fog.color, view.fog.density );

    setupOrders();
    setupSteam();
    setupTrainSound();
    cat =model.getObjectByName( 'cat' );
    catBaseY = cat.position.y;

    // intro: start further out, behind and above the Front view
    const shot = getShot( 'cam_front' );
    camera.fov = shot.userData.fov;
    camera.near = shot.near;
    camera.far = shot.far;
    camera.updateProjectionMatrix();
    controls.target.fromArray( shot.userData.target );
    shot.getWorldPosition( camera.position );
    offset.subVectors( camera.position, controls.target ).multiplyScalar( 2.2 );
    camera.position.copy( controls.target ).add( offset );
    camera.position.y += 1.5;
    camera.lookAt( controls.target );
    applyLimits();

    // wait for the pixel font too, so the buttons don't flash in a plain font first
    document.fonts.ready.then( () => {
        hideLoader();
        // a link like yoursite.com/#projects lands straight on the right bowl
        route();
        if ( !flight ) flyTo( 'cam_front', undefined, INTRO_TIME );
    } );

}, onProgress, function ( error ) {

  console.error( error );
  loaderText.textContent = 'Sorry, the kitchen is closed. Please reload the page.';
  loaderBar.hidden = true;

} );

// bluish sky, warm brown ground; the model's own lanterns and signs do the rest
const light = new THREE.HemisphereLight( 0x6f8fc0, 0x3a2618, 1.6 );
scene.add(light);

camera.position.z = 5;

// camera shots baked into the model:
// cam_front, cam_hero, cam_hero_portrait, cam_counter, cam_izakaya, cam_train,
// cam_chicken, cam_shoyu, cam_miso, cam_spicy
function getShot( name ) {
    const shot = model.getObjectByName( name );
    if ( !shot ) console.warn( 'no camera named', name );
    return shot;
}

// ---- camera limits ----

const targetMin = new THREE.Vector3();
const targetMax = new THREE.Vector3();
const offset = new THREE.Vector3();
const spherical = new THREE.Spherical();

// how far visitors can drag and zoom away from each designed shot
const POLAR_RANGE = 0.25;   // up and down, about 15°
const AZIMUTH_RANGE = 0.35; // left and right, about 20°
const DISTANCE_RANGE = [ 0.7, 1.3 ];

// Keep the camera in a small range around the shot it just landed on,
// so every view (even Train, which looks upward) stays as designed.
function applyLimits() {
    offset.subVectors( camera.position, controls.target );
    spherical.setFromVector3( offset );
    const azimuth = Math.atan2( offset.x, offset.z ); // 0 = looking from +Z, the front

    controls.minDistance = spherical.radius * DISTANCE_RANGE[ 0 ];
    controls.maxDistance = spherical.radius * DISTANCE_RANGE[ 1 ];
    controls.minPolarAngle = Math.max( 0, spherical.phi - POLAR_RANGE );
    controls.maxPolarAngle = Math.min( Math.PI, spherical.phi + POLAR_RANGE );
    controls.minAzimuthAngle = azimuth - AZIMUTH_RANGE;
    controls.maxAzimuthAngle = azimuth + AZIMUTH_RANGE;

    targetMin.fromArray( view.orbitTarget.min ).min( controls.target );
    targetMax.fromArray( view.orbitTarget.max ).max( controls.target );
}

function loosenLimits() {
    controls.minDistance = 0;
    controls.maxDistance = Infinity;
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = Math.PI;
    controls.minAzimuthAngle = -Infinity;
    controls.maxAzimuthAngle = Infinity;
}

// OrbitControls has no setting for this: keep the target inside the box,
// and move the camera by the same amount so the view doesn't twist
const clamped = new THREE.Vector3();
function clampTarget() {
    clamped.copy( controls.target ).clamp( targetMin, targetMax );
    offset.subVectors( clamped, controls.target );
    controls.target.add( offset );
    camera.position.add( offset );
}

// ---- camera flights ----

let flight = null;
const FLIGHT_TIME = 1.2; // seconds
const INTRO_TIME = 2.5;
const easeInOutCubic = ( t ) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow( -2 * t + 2, 3 ) / 2;

function flyTo( name, onLand, duration = FLIGHT_TIME ) {
    if ( !model ) return;
    // the landscape street shot crops badly on a tall screen
    if ( name === 'cam_hero' && isPortrait() ) name = 'cam_hero_portrait';
    const shot = getShot( name );
    if ( !shot ) return;

    flight = {
        t: 0,
        duration: reducedMotion.matches ? duration * 0.25 : duration,
        fromPos: camera.position.clone(),
        toPos: shot.getWorldPosition( new THREE.Vector3() ),
        fromTarget: controls.target.clone(),
        toTarget: new THREE.Vector3().fromArray( shot.userData.target ),
        fromFov: camera.fov,
        toFov: shot.userData.fov,
        onLand,
    };

    // a drag mid-flight would fight the animation, and the limits would pull the camera back
    controls.enabled = false;
    loosenLimits();
}

function updateFlight( delta ) {
    flight.t = Math.min( flight.t + delta / flight.duration, 1 );
    const k = easeInOutCubic( flight.t );

    camera.position.lerpVectors( flight.fromPos, flight.toPos, k );
    controls.target.lerpVectors( flight.fromTarget, flight.toTarget, k );
    camera.fov = THREE.MathUtils.lerp( flight.fromFov, flight.toFov, k );
    camera.updateProjectionMatrix();
    camera.lookAt( controls.target );

    if ( flight.t === 1 ) {
        const onLand = flight.onLand;
        flight = null;
        applyLimits();
        controls.enabled = true;
        if ( onLand ) onLand();
    }
}

// ---- sound ----

const listener = new THREE.AudioListener();
camera.add( listener );
const audioLoader = new THREE.AudioLoader();

function loadSound( url, volume, loop = false ) {
    const sound = new THREE.Audio( listener );
    audioLoader.load( url, ( buffer ) => {
        sound.setBuffer( buffer );
        sound.setLoop( loop );
        sound.setVolume( volume );
        // background starts as soon as both the file and the audio are ready
        if ( loop && listener.context.state === 'running' ) sound.play();
    } );
    sound.baseVolume = volume;
    return sound;
}

function playSound( sound ) {
    if ( !sound.buffer ) return; // still downloading
    if ( sound.isPlaying ) sound.stop();
    sound.setVolume( sound.baseVolume ); // undo any fade from last time
    sound.play();
}

const FADE_TIME = 1; // seconds
function fadeOut( sound ) {
    if ( !sound.isPlaying ) return;
    sound.gain.gain.setTargetAtTime( 0, listener.context.currentTime, FADE_TIME / 4 );
    sound.stop( FADE_TIME );
}

const ambience = loadSound( 'izakaya.mp3', 0.3, true );
const catMeow = loadSound( 'cat_meow.mp3', 0.8 );

// views that play a sound when you pick them; it fades out when you pick another view
const soup = loadSound( 'soup.mp3', 0.75 );
const glasses = loadSound( 'glass_clinking.mp3', 0.6 );
const VIEW_SOUNDS = { cam_front: soup, cam_counter: soup, cam_izakaya: glasses };

function playViewSound( shot ) {
    const next = VIEW_SOUNDS[ shot ];
    for ( const sound of new Set( Object.values( VIEW_SOUNDS ) ) ) {
        if ( sound !== next ) fadeOut( sound );
    }
    if ( next ) playSound( next );
}

// on iPhone, play even when the ring/silent switch is on silent (Safari 17+)
if ( navigator.audioSession ) navigator.audioSession.type = 'playback';

// browsers keep audio muted until the visitor interacts with the page
function unlockAudio() {
    // iOS reports 'interrupted' after a call or locking the phone; that needs a tap too
    if ( listener.context.state === 'running' || document.hidden ) return;
    listener.context.resume().then( () => {
        if ( ambience.buffer && !ambience.isPlaying ) ambience.play();
    } );
}
// a mouse unlocks on press, but a touch only counts when the finger lifts
window.addEventListener( 'pointerdown', unlockAudio );
window.addEventListener( 'pointerup', unlockAudio );
window.addEventListener( 'touchend', unlockAudio ); // older iOS without pointer events counting
window.addEventListener( 'keydown', unlockAudio );

// go quiet while the tab is hidden; only resume if the visitor had already unlocked audio
let audioWasRunning = false;
document.addEventListener( 'visibilitychange', () => {
    if ( document.hidden ) {
        audioWasRunning = listener.context.state === 'running';
        listener.context.suspend();
    } else if ( audioWasRunning ) {
        listener.context.resume();
    }
} );

// ---- train sound ----


// second in each clip when the train starts to move (from the keyframes in the model)
const TRAIN_STARTS = { train_outer: 2, train_inner: 9 };
const trainSounds = {};
const lastTrainTime = {};

function setupTrainSound() {
    audioLoader.load( 'train_sound1.mp3', ( buffer ) => {
        for ( const name in TRAIN_STARTS ) {
            const train = model.getObjectByName( name );
            if ( !train ) continue;
            const sound = new THREE.PositionalAudio( listener );
            sound.setBuffer( buffer );
            sound.setRefDistance( 15 ); // full volume within about the stall's width
            sound.setVolume( 0.8 );
            train.add( sound );
            trainSounds[ name ] = sound;
        }
    } );
}

function updateTrainSound() {
    for ( const name in trainSounds ) {
        const t = actions[ name ].time;
        const last = lastTrainTime[ name ] ?? t;
        lastTrainTime[ name ] = t;
        // the clip loops, so time going backwards means a new lap began
        const crossed = ( last < TRAIN_STARTS[ name ] || t < last ) && t >= TRAIN_STARTS[ name ];
        // skip while still locked, or the sound would play late once audio unlocks
        if ( !crossed || listener.context.state !== 'running' ) continue;
        const sound = trainSounds[ name ];
        if ( sound.isPlaying ) sound.stop();
        sound.play();
    }
}

// ---- steam ----

function makeSteamTexture() {
    const size = 64;
    const canvas = document.createElement( 'canvas' );
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext( '2d' );
    const gradient = ctx.createRadialGradient( size / 2, size / 2, 0, size / 2, size / 2, size / 2 );
    gradient.addColorStop( 0, 'rgba(255, 255, 255, 1)' );
    gradient.addColorStop( 0.4, 'rgba(255, 255, 255, 0.5)' );
    gradient.addColorStop( 1, 'rgba(255, 255, 255, 0)' );
    ctx.fillStyle = gradient;
    ctx.fillRect( 0, 0, size, size );
    const texture = new THREE.CanvasTexture( canvas );
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

const STEAM = {
    big:   { count: 10, rise: 0.8,  drift: 0.12, size: [ 0.12, 0.5 ],  opacity: 0.22, duration: 3.2 }, // pot, boiler
    small: { count: 6,  rise: 0.35, drift: 0.05, size: [ 0.05, 0.18 ], opacity: 0.28, duration: 2.4 }, // bowls
};
const steamPuffs = [];
let steamTime = 0;

function setupSteam() {
    const texture = makeSteamTexture();
    const anchors = [];
    model.updateMatrixWorld( true );
    model.traverse( ( object ) => {
        if ( object.name.startsWith( 'anchor_steam_' ) ) anchors.push( object );
    } );

    for ( const anchor of anchors ) {
        const style = /pot|boiler/.test( anchor.name ) ? STEAM.big : STEAM.small;
        const group = new THREE.Group();
        anchor.getWorldPosition( group.position );
        scene.add( group );

        for ( let i = 0; i < style.count; i++ ) {
            const sprite = new THREE.Sprite( new THREE.SpriteMaterial( {
                map: texture,
                color: 0xdfe6f0,
                transparent: true,
                opacity: 0,
                depthWrite: false, // so puffs don't cut into each other
            } ) );
            group.add( sprite );
            steamPuffs.push( {
                sprite,
                style,
                phase: i / style.count, // spread the puffs through the cycle
                angle: Math.random() * Math.PI * 2,
            } );
        }
    }
}

function updateSteam( delta ) {
    steamTime += delta;
    for ( const puff of steamPuffs ) {
        const { sprite, style } = puff;
        const t = ( steamTime / style.duration + puff.phase ) % 1; // 0 at the bottom, 1 at the top
        const wobble = Math.sin( steamTime * 1.3 + puff.phase * 6 ) * style.drift * 0.4;

        sprite.position.set(
            ( Math.cos( puff.angle ) * style.drift + wobble ) * t,
            style.rise * t,
            Math.sin( puff.angle ) * style.drift * t,
        );
        sprite.scale.setScalar( THREE.MathUtils.lerp( style.size[ 0 ], style.size[ 1 ], t ) );
        sprite.material.opacity = style.opacity * Math.sin( t * Math.PI ); // fade in, then out
    }
}

// ---- ordering: hover and click the bowls and menu tags ----

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const orderLabel = document.getElementById( 'order-label' );
let orderTargets = []; // the 8 objects to test: each order's bowl group and menu tag
let orderCameras = {}; // order id -> camera shot, e.g. chicken -> cam_chicken
let hovered = null;    // userData of the order under the pointer
const HOVER_SCALE = 1.08;

function setupOrders() {
    for ( const order of model.userData.orders ) {
        orderCameras[ order.id ] = order.camera;
        for ( const name of [ order.bowl, order.tag ] ) {
            const object = model.getObjectByName( name );
            if ( !object ) continue;
            object.userData.baseScale = object.scale.clone();
            orderTargets.push( object );
        }
    }
}

// point the raycaster from the camera through this pointer event
function aim( event ) {
    // normalized device coordinates: -1 to 1 across and up (y is flipped)
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ( ( event.clientX - rect.left ) / rect.width ) * 2 - 1;
    pointer.y = -( ( event.clientY - rect.top ) / rect.height ) * 2 + 1;
    raycaster.setFromCamera( pointer, camera );
}

// which order is under this pointer event, or null
function pickOrder( event ) {
    aim( event );
    const hits = raycaster.intersectObjects( orderTargets, true );
    if ( hits.length === 0 ) return null;

    // the hit is a mesh inside the order group, so walk up to the group
    for ( let object = hits[ 0 ].object; object; object = object.parent ) {
        if ( object.userData.type === 'order' ) return object.userData;
    }
    return null;
}

// scale up both the bowl and its tag, since they're the same order
function setHighlight( order, on ) {
    for ( const object of orderTargets ) {
        if ( object.userData.id !== order.id ) continue;
        object.scale.copy( object.userData.baseScale );
        if ( on ) object.scale.multiplyScalar( HOVER_SCALE );
    }
}

function setHovered( order ) {
    if ( order?.id === hovered?.id ) return;
    if ( hovered ) setHighlight( hovered, false );
    hovered = order;

    if ( order ) {
        setHighlight( order, true );
        const page = order.page[ 0 ].toUpperCase() + order.page.slice( 1 );
        orderLabel.textContent = `${ order.label } ${ order.ja } → ${ page }`;
        orderLabel.hidden = false;
        renderer.domElement.style.cursor = 'pointer';
    } else {
        orderLabel.hidden = true;
        renderer.domElement.style.cursor = '';
    }
}

// clicking a bowl only sets the hash; route() does the rest
function placeOrder( picked ) {
    setHovered( null );
    if ( location.hash === '#' + picked.page ) route(); // same page again: no hashchange fires
    else location.hash = picked.page;
}

// ---- the cat jumps when you click him ----

let cat;
let catBaseY;
let catJump = -1; // progress 0 to 1 while jumping, -1 when on the ground
const CAT_JUMP_HEIGHT = 0.35; // metres
const CAT_JUMP_TIME = 0.55;   // seconds

function pickCat( event ) {
    aim( event );
    return raycaster.intersectObject( cat, true ).length > 0;
}

function jumpCat() {
    if ( catJump >= 0 ) return; // ignore clicks mid-air
    catJump = 0;
    playSound( catMeow );
}

function updateCat( delta ) {
    if ( catJump < 0 ) return;
    catJump = Math.min( catJump + delta / CAT_JUMP_TIME, 1 );
    const t = catJump;

    // up and down along a parabola: 0 at take-off and landing, 1 at the top
    cat.position.y = catBaseY + CAT_JUMP_HEIGHT * 4 * t * ( 1 - t );
    // stretch on the way up, settle back by landing
    const stretch = 1 + 0.15 * Math.sin( t * Math.PI );
    cat.scale.set( 1 / Math.sqrt( stretch ), stretch, 1 / Math.sqrt( stretch ) );

    if ( catJump === 1 ) {
        cat.position.y = catBaseY;
        cat.scale.set( 1, 1, 1 );
        catJump = -1;
    }
}

// pointer events, so the same code works for touch
const canvas = renderer.domElement;
const downAt = new THREE.Vector2();
const CLICK_SLOP = 5; // pixels; more movement than this was a drag, not a click

canvas.addEventListener( 'pointermove', ( event ) => {
    // nothing to hover while flying, while dragging, or on touch (no hover there)
    if ( !model || flight || event.buttons || event.pointerType === 'touch' ) {
        setHovered( null );
        return;
    }
    setHovered( pickOrder( event ) );
    canvas.style.cursor = hovered || pickCat( event ) ? 'pointer' : '';
    orderLabel.style.transform = `translate(${ event.clientX + 16 }px, ${ event.clientY + 16 }px)`;
} );

canvas.addEventListener( 'pointerleave', () => setHovered( null ) );

canvas.addEventListener( 'pointerdown', ( event ) => {
    downAt.set( event.clientX, event.clientY );
} );

canvas.addEventListener( 'pointerup', ( event ) => {
    if ( !model || flight || event.button !== 0 ) return;
    // a drag that ends over a bowl still fires; ignore it so orbiting never orders by accident
    if ( downAt.distanceTo( new THREE.Vector2( event.clientX, event.clientY ) ) > CLICK_SLOP ) return;

    const picked = pickOrder( event );
    if ( picked ) placeOrder( picked );
    else if ( pickCat( event ) ) jumpCat();
} );

for ( const button of document.querySelectorAll( '#views button' ) ) {
    button.addEventListener( 'click', () => {
        // leave any open page without route() flying back to the counter
        if ( location.hash ) {
            history.pushState( null, '', location.pathname + location.search );
            closePanel();
        }
        flyTo( button.dataset.shot );
        playViewSound( button.dataset.shot );
    } );
}

// the plain menu links work through the hash already;
// this only covers clicking the page that's already in the URL
for ( const link of document.querySelectorAll( '#pages a' ) ) {
    link.addEventListener( 'click', ( event ) => {
        if ( location.hash === link.hash ) {
            event.preventDefault();
            route();
        }
    } );
}

// ---- pages: the URL hash decides what's open ----

const panel = document.getElementById( 'panel' );
const panelClose = document.getElementById( 'panel-close' );
const sections = panel.querySelectorAll( 'section[data-page]' );
let openPage = null;

function openPanel( page ) {
    for ( const section of sections ) section.hidden = section.dataset.page !== page;
    panel.scrollTop = 0;
    panel.inert = false;
    panel.classList.add( 'open' );
    openPage = page;
    panelClose.focus( { preventScroll: true } );
}

function closePanel() {
    panel.classList.remove( 'open' );
    panel.inert = true;
    openPage = null;
}

// one handler for bowl clicks, links, page load and the Back button
function route() {
    if ( !model ) return; // runs again once the model has loaded

    const page = location.hash.slice( 1 );
    const picked = model.userData.orders.find( ( o ) => o.page === page );

    if ( picked ) {
        // another bowl while a page is open just switches pages when the camera lands
        flyTo( picked.camera, () => openPanel( picked.page ) );
    } else if ( openPage || flight?.onLand ) {
        // closing a page (or cancelling a flight to one): back to the seat
        closePanel();
        flyTo( 'cam_counter' );
    }
}

window.addEventListener( 'hashchange', route );

// close button and Escape clear the hash; the Back button then reopens the page
function clearHash() {
    history.pushState( null, '', location.pathname + location.search );
    route();
}

panelClose.addEventListener( 'click', clearHash );
document.addEventListener( 'keydown', ( event ) => {
    if ( event.key === 'Escape' && location.hash ) clearHash();
} );

// ---- keep the bowl visible beside the panel ----
// setViewOffset shifts the whole picture without moving the camera:
// left of the side panel on desktop, above the bottom sheet on phones

let viewShift = 0; // eases between 0 (panel closed) and 1 (open)

function updateViewOffset( delta ) {
    const goal = panel.classList.contains( 'open' ) ? 1 : 0;
    viewShift = reducedMotion.matches ? goal : viewShift + ( goal - viewShift ) * Math.min( 1, delta * 6 );
    if ( Math.abs( goal - viewShift ) < 0.001 ) viewShift = goal;

    if ( viewShift === 0 ) {
        if ( camera.view?.enabled ) camera.clearViewOffset();
        return;
    }

    // measured every frame, so resizing and the sheet's height are always right
    const width = window.innerWidth;
    const height = window.innerHeight;
    const x = sheetLayout.matches ? 0 : ( panel.offsetWidth / 2 ) * viewShift;
    const y = sheetLayout.matches ? ( panel.offsetHeight / 2 ) * viewShift : 0;
    camera.setViewOffset( width, height, x, y, width, height );
}

window.addEventListener( 'resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize( window.innerWidth, window.innerHeight );
    composer.setPixelRatio( renderer.getPixelRatio() );
    composer.setSize( window.innerWidth, window.innerHeight );
} );

function animate( time ) {
  timer.update( time );
  const delta = timer.getDelta();

  if ( mixer ) {
    mixer.update( delta );
    updateTrainSound();
  }
  if ( cat ) updateCat( delta );
  updateSteam( delta );

  if ( flight ) {
    updateFlight( delta );
  } else if ( view ) {
    controls.update(); // needed every frame for damping
    clampTarget(); // after update(), which is where panning moves the target
  }
  updateViewOffset( delta );

  composer.render();
}
renderer.setAnimationLoop( animate );
