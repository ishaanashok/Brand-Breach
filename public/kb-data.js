// The Rolex knowledge base, written by hand. It is staged for the demo and is the same every time.
(() => {
  const OFFICIAL_DOMAINS = ['rolex.com', 'rolex.org']

  // What the opening page says while it fills up, one after another.
  const PHRASES = ['Finding official sources...', 'Compiling brand reference imagery...', 'Collecting official accounts...', 'Learning abuse patterns...']

  // What the opening page gathers. Every section fills at once.
  const GATHER = [
    {
      title: 'Official websites', kind: 'rows', items: [
        'https://www.rolex.com/',
        'https://www.rolex.com/watches',
        'https://www.rolex.com/watches/submariner',
        'https://www.rolex.com/watches/cosmograph-daytona',
        'https://www.rolex.com/watches/gmt-master-ii',
        'https://www.rolex.com/rolex-certified-pre-owned',
        'https://www.rolex.com/store-locator',
        'https://www.rolex.org/',
      ],
    },
    {
      title: 'Official accounts', kind: 'rows', items: [
        'instagram.com/rolex',
        'youtube.com/rolex',
        'x.com/rolex',
        'facebook.com/rolex',
        'linkedin.com/company/rolex',
        'pinterest.com/rolex',
      ],
    },
    {
      title: 'Reference imagery', kind: 'watches', items: [
        { name: 'Submariner', ref: '126610LN', bezel: '#111', dial: '#0b0b0b', band: '#a9adb2' },
        { name: 'Submariner Date', ref: '126610LV', bezel: '#0c6b3c', dial: '#0b0b0b', band: '#a9adb2' },
        { name: 'GMT-Master II', ref: '126710BLRO', bezel: 'split', dial: '#0b0b0b', band: '#a9adb2' },
        { name: 'Daytona', ref: '126500LN', bezel: '#111', dial: '#eceae4', band: '#a9adb2' },
        { name: 'Datejust 41', ref: '126334', bezel: '#d4d6d9', dial: '#23406e', band: '#a9adb2' },
        { name: 'Day-Date 40', ref: '228238', bezel: '#d6b25e', dial: '#d6b25e', band: '#c9a54e' },
        { name: 'Explorer', ref: '224270', bezel: '#b9bcc0', dial: '#0b0b0b', band: '#a9adb2' },
        { name: 'Yacht-Master', ref: '226659', bezel: '#111', dial: '#0b0b0b', band: '#2a2a2a' },
      ],
    },
    {
      title: 'Abuse patterns', kind: 'patterns', items: [
        '“1:1 super clone” and “AAA grade” wording',
        'Named replica factories: Noob, Clean, VSF',
        'Lookalike domains: rolex-outlet, rolexsale',
        'New models far below retail price',
        'Group chat sellers quoting “factory direct”',
        'Coronet logo on non-Rolex products',
        'Fake giveaways using ambassador photos',
        'Wrong cyclops, rehaut or date font in photos',
      ],
    },
  ]

  const c = (id, label, at, kind, about, items) => ({ id, label, at, kind, about, items })
  const CLUSTERS = [
    c('official', 'Official websites', [-120, -560], 'official', 'Pages Rolex runs itself. Never flagged.', ['rolex.com', 'rolex.org', 'rolex.com/watches', 'rolex.com/store-locator', 'rolex.com/world-of-rolex', 'rolex.com/watchmaking', 'rolex.com/watch-care-and-service', 'rolex.com/legal-notices']),
    c('accounts', 'Official accounts', [480, -620], 'official', 'Verified accounts, used to tell real posts from copies.', ['instagram.com/rolex', 'youtube.com/rolex', 'x.com/rolex', 'facebook.com/rolex', 'linkedin.com/company/rolex', 'pinterest.com/rolex', '#rolex (verified)', '@rolex (verified)']),
    c('models', 'Collections', [980, -180], 'hub', 'Model names sellers use to get found.', ['Submariner', 'Cosmograph Daytona', 'GMT-Master II', 'Datejust', 'Day-Date', 'Explorer', 'Explorer II', 'Sea-Dweller', 'Deepsea', 'Yacht-Master', 'Yacht-Master II', 'Sky-Dweller', 'Air-King', 'Oyster Perpetual', '1908', 'Cellini', 'Milgauss', 'Turn-O-Graph']),
    c('refs', 'Reference numbers', [1320, 330], 'hub', 'Exact model references, often copied into fake listings.', ['126610LN', '126610LV', '124060', '126500LN', '126710BLRO', '126710BLNR', '126720VTNR', '126334', '126300', '228238', '224270', '226570', '126600', '136660', '226659', '326934', '126900', '124300', '52508']),
    c('nick', 'Collector nicknames', [800, 820], 'hub', 'What collectors call them, and so what buyers search for.', ['Pepsi', 'Batman', 'Sprite', 'Hulk', 'Kermit', 'Starbucks', 'Smurf', 'Panda', 'Bruce Wayne', 'Wimbledon dial', 'James Cameron', 'Polar']),
    c('visual', 'Visual marks', [120, 960], 'image', 'What a real watch looks like in a photo.', ['Coronet logo', 'Cyclops lens at 2.5x', 'Laser-etched crown in crystal', 'Rehaut engraving', 'Cerachrom bezel', 'Oyster bracelet', 'Jubilee bracelet', 'President bracelet', 'Glidelock clasp', 'Oysterlock clasp', 'Green seal tag', 'Green and gold box', 'Maxi dial', 'Date font', 'Triplock crown', 'Serial between lugs']),
    c('tech', 'Materials and movements', [-620, 880], 'hub', 'Terms from Rolex specifications. Fakes often misuse them.', ['Oystersteel', 'Rolesor', 'Everose gold', 'Chromalight', 'Parachrom hairspring', 'Chronergy escapement', 'Perpetual rotor', 'Calibre 3235', 'Calibre 3285', 'Calibre 4131', 'Calibre 3230', 'Superlative Chronometer', 'Paraflex shock absorbers', 'Syloxi hairspring']),
    c('sellers', 'Authorized channels', [-1120, 420], 'official', 'Who may legitimately sell. Handled with care.', ['Official Rolex Jewellers', 'Rolex Certified Pre-Owned', 'Bucherer', 'Watches of Switzerland', 'Mayors', 'Tourneau', 'Goldsmiths', 'Mappin & Webb', 'Wempe', 'Rolex service centres']),
    c('company', 'The company', [-1320, -160], 'hub', 'Who is behind the brand.', ['Hans Wilsdorf', 'Hans Wilsdorf Foundation', 'Rolex SA', 'Geneva', 'Bienne', 'Plan-les-Ouates', 'Chêne-Bourg', 'Tudor', 'Wilsdorf & Davis', 'Oyster case, 1926', 'Perpetual rotor, 1931']),
    c('world', 'Partnerships', [-860, -720], 'hub', 'People and events whose photos get borrowed for scams.', ['Wimbledon', 'The Masters', '24 Hours of Le Mans', 'Monterey Car Week', 'SailGP', 'Rolex Sydney Hobart', 'Roger Federer', 'Tiger Woods', 'Perpetual Planet', 'Everest expeditions', 'Rolex Awards', 'Mentor and Protégé']),
    c('words', 'Replica wording', [1040, -800], 'risk', 'Words that point to counterfeits.', ['super clone', '1:1 replica', 'AAA grade', 'mirror quality', 'noob factory', 'clean factory', 'VSF', 'EW factory', 'Swiss movement clone', 'homage', 'rep watch', 'best quality copy', 'factory direct']),
    c('tricks', 'Selling tricks', [420, 320], 'risk', 'How fake sellers avoid being caught.', ['Price far below retail', 'Message me for photos', 'Payment by crypto only', 'WhatsApp to order', 'Telegram catalogue', 'Mystery box', 'Free watch giveaway', 'Papers sold separately', 'Blurred logo in photos', 'Logo hidden until checkout', 'Ships from new account', 'Reused product photos']),
    c('where', 'Where abuse shows up', [-340, 320], 'risk', 'Surfaces with the most Rolex abuse.', ['Lookalike domains', 'rolex-outlet patterns', 'Instagram resellers', 'TikTok Shop', 'Facebook Marketplace', 'Telegram channels', 'WhatsApp groups', 'DHgate', 'AliExpress', 'eBay', 'YouTube review funnels', 'Discord servers']),
    c('tags', 'Hashtags', [-500, -230], 'tag', 'Tags that surface listings and buyers.', ['#rolex', '#rolexsubmariner', '#rolexdaytona', '#rolexgmt', '#rolexdatejust', '#rolexwatch', '#rolexclub', '#watchesofinstagram', '#wristgame', '#superclone', '#repwatch', '#replicawatch', '#cleanfactory', '#noobfactory', '#watchfam', '#horology', '#dailywatch', '#luxurywatch']),
    c('legal', 'Rights and takedowns', [-1000, -1000], 'hub', 'How a confirmed case gets acted on.', ['ROLEX word mark', 'Coronet device mark', 'OYSTER PERPETUAL mark', 'Trade dress', 'Lanham Act', 'DMCA notice', 'UDRP complaint', 'Meta Brand Rights Protection', 'Amazon Brand Registry', 'eBay VeRO', 'Alibaba IPP', 'TikTok IP Protection']),
  ]

  // Links between clusters, which make it read as one body of knowledge.
  const LINKS = [
    ['Rolex', 'official'], ['Rolex', 'accounts'], ['Rolex', 'models'], ['Rolex', 'visual'], ['Rolex', 'tech'], ['Rolex', 'sellers'], ['Rolex', 'company'], ['Rolex', 'world'], ['Rolex', 'tricks'], ['Rolex', 'where'], ['Rolex', 'tags'], ['Rolex', 'legal'],
    ['models', 'refs'], ['models', 'nick'], ['words', 'tricks'], ['legal', 'official'], ['visual', 'tech'],
    ['Pepsi', '126710BLRO'], ['Batman', '126710BLNR'], ['Sprite', '126720VTNR'], ['Starbucks', '126610LV'], ['Panda', '126500LN'], ['Bruce Wayne', 'GMT-Master II'], ['Pepsi', 'GMT-Master II'], ['Kermit', 'Submariner'], ['Hulk', 'Submariner'], ['126610LN', 'Submariner'], ['124060', 'Submariner'], ['126500LN', 'Cosmograph Daytona'], ['126334', 'Datejust'], ['228238', 'Day-Date'], ['224270', 'Explorer'], ['226570', 'Explorer II'], ['126600', 'Sea-Dweller'], ['136660', 'Deepsea'], ['226659', 'Yacht-Master'], ['326934', 'Sky-Dweller'], ['126900', 'Air-King'], ['124300', 'Oyster Perpetual'], ['52508', '1908'],
    ['#rolexsubmariner', 'Submariner'], ['#rolexdaytona', 'Cosmograph Daytona'], ['#rolexgmt', 'GMT-Master II'], ['#rolexdatejust', 'Datejust'], ['#superclone', 'super clone'], ['#repwatch', 'rep watch'], ['#replicawatch', '1:1 replica'], ['#cleanfactory', 'clean factory'], ['#noobfactory', 'noob factory'], ['#rolex', 'instagram.com/rolex'],
    ['Calibre 3235', 'Datejust'], ['Calibre 4131', 'Cosmograph Daytona'], ['Calibre 3285', 'GMT-Master II'], ['Calibre 3230', 'Explorer'], ['Cerachrom bezel', 'Submariner'], ['Jubilee bracelet', 'Datejust'], ['President bracelet', 'Day-Date'], ['Cyclops lens at 2.5x', 'Datejust'], ['Glidelock clasp', 'Submariner'], ['Chromalight', 'Maxi dial'],
    ['Instagram resellers', 'instagram.com/rolex'], ['YouTube review funnels', 'youtube.com/rolex'], ['Telegram channels', 'Telegram catalogue'], ['WhatsApp groups', 'WhatsApp to order'], ['Lookalike domains', 'rolex.com'], ['rolex-outlet patterns', 'Lookalike domains'], ['DHgate', 'AAA grade'], ['AliExpress', 'homage'], ['Free watch giveaway', 'Roger Federer'], ['Free watch giveaway', 'Tiger Woods'], ['Mystery box', 'TikTok Shop'], ['Instagram resellers', 'Message me for photos'], ['Blurred logo in photos', 'Coronet logo'], ['Papers sold separately', 'Green seal tag'], ['Reused product photos', 'Rolex Certified Pre-Owned'],
    ['Meta Brand Rights Protection', 'Instagram resellers'], ['Meta Brand Rights Protection', 'Facebook Marketplace'], ['Alibaba IPP', 'AliExpress'], ['eBay VeRO', 'eBay'], ['TikTok IP Protection', 'TikTok Shop'], ['UDRP complaint', 'Lookalike domains'], ['Coronet device mark', 'Coronet logo'], ['ROLEX word mark', 'Rolex SA'], ['OYSTER PERPETUAL mark', 'Oyster Perpetual'],
    ['Hans Wilsdorf', 'Hans Wilsdorf Foundation'], ['Hans Wilsdorf', 'Wilsdorf & Davis'], ['Tudor', 'Hans Wilsdorf Foundation'], ['Rolex SA', 'Geneva'], ['Bucherer', 'Official Rolex Jewellers'], ['rolex.com/store-locator', 'Official Rolex Jewellers'], ['Oyster case, 1926', 'Oyster bracelet'], ['Perpetual rotor, 1931', 'Perpetual rotor'], ['Wimbledon', 'rolex.com/world-of-rolex'], ['Perpetual Planet', 'rolex.org'], ['Rolex Awards', 'rolex.org'], ['Wimbledon', 'Roger Federer'], ['The Masters', 'Tiger Woods'], ['Everest expeditions', 'Explorer'], ['24 Hours of Le Mans', 'Cosmograph Daytona'],
  ]

  /** Places every node. There is no randomness, so the graph looks the same on every load. */
  function buildGraph() {
    const nodes = [{ id: 'Rolex', label: 'Rolex', kind: 'root', x: 0, y: 0, about: 'The brand being protected.' }]
    const byId = new Map([['Rolex', nodes[0]]])
    const add = n => { nodes.push(n); byId.set(n.id, n); return n }
    const edges = []
    for (const cl of CLUSTERS) {
      add({ id: cl.id, label: cl.label, kind: cl.kind === 'official' || cl.kind === 'risk' || cl.kind === 'tag' || cl.kind === 'image' ? `${cl.kind}-hub` : 'hub', x: cl.at[0], y: cl.at[1], fixed: true, about: cl.about })
      cl.items.forEach((label, i) => {
        // A sunflower spiral: an even spread with no two runs differing.
        const angle = i * 2.39996
        const r = 110 + 30 * Math.sqrt(i) * 2.2
        add({ id: label, label, kind: cl.kind === 'hub' ? 'fact' : cl.kind, parent: cl.id, x: cl.at[0] + Math.cos(angle) * r, y: cl.at[1] + Math.sin(angle) * r, about: cl.about })
        edges.push([cl.id, label])
      })
    }
    for (const [a, b] of LINKS) if (byId.has(a) && byId.has(b)) edges.push([a, b])
    // A few rounds of pushing neighbours apart, so that labels overlap less.
    for (let round = 0; round < 60; round++) {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j]
          const dx = b.x - a.x, dy = b.y - a.y
          const d = Math.hypot(dx, dy) || 1
          if (d > 90) continue
          const push = (90 - d) / d / 2
          if (!a.fixed && a.kind !== 'root') { a.x -= dx * push; a.y -= dy * push }
          if (!b.fixed && b.kind !== 'root') { b.x += dx * push; b.y += dy * push }
        }
      }
    }
    return { nodes, edges }
  }

  globalThis.RolexKb = { OFFICIAL_DOMAINS, PHRASES, GATHER, CLUSTERS, LINKS, buildGraph }
})()
