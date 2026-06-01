(function () {
  var madrona = {
    loadudo: function (data) {
      
      try {
        const parsedData = JSON.parse(data);
		const validPlacementIds = ["280", "20047"];
		// All placements except special case
        let scriptContent = `var utag_data = ${data};`;

        // Check if the placement ID is belongs to special case
        if (validPlacementIds.includes(parsedData.madrona_placement_id)) {
          // Wrap utag.view call in a timeout and check if utag is defined
          if ( typeof utag === 'undefined' ){
					 setTimeout(() => {
					 scriptContent = 'utag && utag.view(' + data +');';}, 1000); }
		  else{
					 scriptContent = 'utag.view(' + data +');'; }		
        }

        // Create and insert a script element
        const scriptElement = document.createElement('script');
        scriptElement.text = scriptContent;
        scriptElement.type = 'text/javascript';
        document.body.insertBefore(scriptElement, document.body.firstChild);

        } 
		catch (error) {
        console.error('Error parsing data:', error);
      }
    }
  };

  window.madrona = madrona;

  // Load utag script if not already defined
  if (typeof utag === 'undefined') {
    const utagScriptUrl = 'https://mkttag.ebay.com/tag-manager/v1/tag/utag.js';

    const utagScript = document.createElement('script');
    utagScript.src = utagScriptUrl;
    utagScript.type = 'text/javascript';
    utagScript.async = true;

    document.body.insertBefore(utagScript, document.body.firstChild);
  }
})();