import WebGL from 'three/addons/capabilities/WebGL.js';

// Only download three.js and the model when this device can draw them.
// Without WebGL, the pages are shown as a normal scrolling page instead.
if ( WebGL.isWebGL2Available() ) {
    import( './main.js' ).catch( ( error ) => {
        console.error( error );
        showPlainPage();
    } );
} else {
    showPlainPage();
}

function showPlainPage() {
    document.body.classList.add( 'plain' );
    const panel = document.getElementById( 'panel' );
    panel.inert = false;
    for ( const section of panel.querySelectorAll( 'section' ) ) section.hidden = false;
}
