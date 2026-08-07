const { getStreams } = require('./src/scrapers/index');

async function testTitle(type, tmdbId, imdbId, name, year, season, episode) {
    console.log(`\n==============================================`);
    console.log(`Testing: ${name} (${type === 'series' ? `S${season}E${episode}` : year}) [TMDB: ${tmdbId}]`);
    console.log(`==============================================`);
    
    try {
        const streams = await getStreams(type, `tmdb:${type}:${tmdbId}`, season, episode);
        
        console.log(`\n✅ Total Working Streams Found: ${streams.length}`);
        
        const workingDirect = streams.filter(s => s.url);
        const externalFallback = streams.filter(s => s.externalUrl);
        
        console.log(`- Direct Playable Native Streams (m3u8/mp4): ${workingDirect.length}`);
        console.log(`- External Web Player Fallbacks: ${externalFallback.length}`);
        
        if (streams.length > 0) {
            console.log('\nTop 5 Streams:');
            streams.slice(0, 5).forEach((s, i) => {
                const title = s.title.replace(/\n/g, ' | ');
                console.log(`  ${i+1}. ${s.name} - ${title}`);
                if (s.url) console.log(`     URL: ${s.url.substring(0, 80)}...`);
                else if (s.externalUrl) console.log(`     ExtURL: ${s.externalUrl}`);
            });
        } else {
            console.log('❌ No working streams found for this title.');
        }
    } catch (e) {
        console.error("Error testing title:", e.message);
    }
}

async function runTests() {
    // Avengers Endgame
    await testTitle('movie', '299534', 'tt4154796', 'Avengers: Endgame', 2019);
    
    // The Last of Us (Series)
    await testTitle('series', '100088', 'tt3581920', 'The Last of Us', 2023, 1, 1);
    
    // Deadpool & Wolverine (Recent)
    await testTitle('movie', '533535', 'tt6263850', 'Deadpool & Wolverine', 2024);
    
    // Breaking Bad
    await testTitle('series', '1396', 'tt0903747', 'Breaking Bad', 2008, 2, 1);
}

runTests();
