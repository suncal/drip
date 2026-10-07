/* Drip — merchant resolution.
 *
 * Bank descriptors are hostile: `SQ *BLUE BOTTLE 8452`, `AMZN Mktp US*2K4TY9`,
 * `PAYPAL *SPOTIFY USA`, `POS DEBIT 0912 NETFLIX.COM 866-579-7172 CA`. All of
 * those must collapse to one merchant or every downstream number is wrong.
 *
 * Three passes: strip payment-processor wrappers, strip per-transaction noise
 * (store numbers, reference ids, phone numbers, locations, dates), then match
 * against a known-merchant table before falling back to a cleaned label.
 */
(function (global) {
  'use strict';

  /* Payment processors and terminal prefixes that wrap the real merchant. */
  var PROCESSOR = new RegExp(
    '^(?:' + [
      'sq\\s*\\*', 'sqc\\*', 'tst\\*', 'tst\\s*\\*', 'py\\s*\\*', 'pp\\s*\\*',
      'paypal\\s*\\*', 'paypal\\s+inst\\s+xfer', 'stripe\\s*\\*', 'sp\\s+',
      'sp\\s*\\*', 'wl\\s*\\*', 'clv\\s*\\*', 'toast\\s*\\*', 'shopify\\s*\\*',
      'sumup\\s*\\*', 'izettle\\s*\\*', 'zettle\\s*\\*', 'gumroad\\s*\\*',
      'chk\\s*\\*', 'fs\\s*\\*', 'eb\\s*\\*', 'ec\\s*\\*',
      'pos\\s+debit', 'pos\\s+purchase', 'debit\\s+card\\s+purchase',
      'card\\s+purchase', 'purchase\\s+authorized\\s+on',
      'recurring\\s+payment', 'recurring\\s+card\\s+payment',
      'ach\\s+debit', 'ach\\s+web', 'ach\\s+pmt', 'direct\\s+debit',
      'preauthorized\\s+debit', 'pre-auth\\s+debit', 'electronic\\s+payment',
      'visa\\s+purchase', 'mastercard', 'maestro', 'contactless',
      'apple\\s+pay', 'google\\s+pay', 'gpay\\s*\\*', 'amzn\\s+mktp',
      'withdrawal', 'payment\\s+to', 'bill\\s+payment', 'dd\\s+', 'bp\\s+'
    ].join('|') + ')\\s*', 'i');

  /* Per-transaction noise: ids, store numbers, phones, dates, locations. */
  var NOISE = [
    /\b\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?\b/g,        // embedded dates
    /\b\d{3}[- ]?\d{3}[- ]?\d{4}\b/g,                      // phone numbers
    /\b\+?\d{7,}\b/g,                                       // long numeric ids
    /\b(?:ref|ref#|auth|authorisation|authorization|trace|id|inv|invoice|ord|order|txn|trn|conf|seq)\s*[:#]?\s*[a-z0-9\-]{4,}\b/gi,
    /#\s*\d+/g,                                             // store #1234
    /\bstore\s*\d+\b/gi,
    /\*[a-z0-9]{4,}\b/gi,                                   // *2K4TY9 tails
    /\b[a-z]{0,2}\d{4,}[a-z]{0,2}\b/gi,                     // mixed id blobs
    /\b\d{1,5}\s+[a-z]+\s+(?:st|street|rd|road|ave|avenue|blvd|way|ln|lane|dr|drive)\b/gi,
    /\b(?:usa|us|uk|gbr|gb|can|ca|aus|au|ind|in|deu|de|fra|fr|nld|nl|irl|ie|sgp|sg)\b\s*$/gi,
    /\b[a-z]{2}\s*\d{5}(?:-\d{4})?\b/gi,                    // state + zip
    /\bhttps?:\/\/\S+/gi,
    /\b(?:www\.)?[a-z0-9-]+\.(?:com|net|org|io|co|co\.uk|de|fr|in)\b/gi
  ];

  /* Known merchants -> canonical name + category. Matching is substring on the
     cleaned descriptor, longest pattern first, so `amazon prime` beats `amazon`. */
  var KNOWN = [
    // streaming video
    ['netflix', 'Netflix', 'Streaming video'],
    ['disney plus', 'Disney+', 'Streaming video'],
    ['disneyplus', 'Disney+', 'Streaming video'],
    ['disney+', 'Disney+', 'Streaming video'],
    ['hulu', 'Hulu', 'Streaming video'],
    ['max.com', 'Max', 'Streaming video'],
    ['hbo max', 'Max', 'Streaming video'],
    ['hbomax', 'Max', 'Streaming video'],
    ['paramount+', 'Paramount+', 'Streaming video'],
    ['paramountplus', 'Paramount+', 'Streaming video'],
    ['peacock', 'Peacock', 'Streaming video'],
    ['apple tv', 'Apple TV+', 'Streaming video'],
    ['crunchyroll', 'Crunchyroll', 'Streaming video'],
    ['mubi', 'MUBI', 'Streaming video'],
    ['britbox', 'BritBox', 'Streaming video'],
    ['now tv', 'NOW', 'Streaming video'],
    ['sling tv', 'Sling TV', 'Streaming video'],
    ['fubo', 'Fubo', 'Streaming video'],
    ['youtube premium', 'YouTube Premium', 'Streaming video'],
    ['youtubepremium', 'YouTube Premium', 'Streaming video'],
    ['youtube tv', 'YouTube TV', 'Streaming video'],
    ['hotstar', 'Disney+ Hotstar', 'Streaming video'],
    ['sonyliv', 'SonyLIV', 'Streaming video'],
    ['zee5', 'ZEE5', 'Streaming video'],

    // music & audio
    ['spotify', 'Spotify', 'Music & audio'],
    ['apple music', 'Apple Music', 'Music & audio'],
    ['tidal', 'TIDAL', 'Music & audio'],
    ['deezer', 'Deezer', 'Music & audio'],
    ['soundcloud', 'SoundCloud', 'Music & audio'],
    ['audible', 'Audible', 'Music & audio'],
    ['pandora', 'Pandora', 'Music & audio'],
    ['bandcamp', 'Bandcamp', 'Music & audio'],
    ['gaana', 'Gaana', 'Music & audio'],
    ['jiosaavn', 'JioSaavn', 'Music & audio'],

    // cloud & storage
    ['dropbox', 'Dropbox', 'Cloud storage'],
    ['google one', 'Google One', 'Cloud storage'],
    ['google storage', 'Google One', 'Cloud storage'],
    ['icloud', 'iCloud+', 'Cloud storage'],
    ['apple.com/bill', 'Apple', 'App stores & devices'],
    ['onedrive', 'OneDrive', 'Cloud storage'],
    ['backblaze', 'Backblaze', 'Cloud storage'],
    ['pcloud', 'pCloud', 'Cloud storage'],
    ['box.com', 'Box', 'Cloud storage'],

    // software & productivity
    ['adobe', 'Adobe', 'Software'],
    ['microsoft 365', 'Microsoft 365', 'Software'],
    ['office 365', 'Microsoft 365', 'Software'],
    ['msft', 'Microsoft', 'Software'],
    ['notion', 'Notion', 'Software'],
    ['evernote', 'Evernote', 'Software'],
    ['slack', 'Slack', 'Software'],
    ['zoom', 'Zoom', 'Software'],
    ['canva', 'Canva', 'Software'],
    ['figma', 'Figma', 'Software'],
    ['grammarly', 'Grammarly', 'Software'],
    ['1password', '1Password', 'Security'],
    ['lastpass', 'LastPass', 'Security'],
    ['dashlane', 'Dashlane', 'Security'],
    ['bitwarden', 'Bitwarden', 'Security'],
    ['nordvpn', 'NordVPN', 'Security'],
    ['expressvpn', 'ExpressVPN', 'Security'],
    ['surfshark', 'Surfshark', 'Security'],
    ['malwarebytes', 'Malwarebytes', 'Security'],
    ['norton', 'Norton', 'Security'],
    ['mcafee', 'McAfee', 'Security'],
    ['jetbrains', 'JetBrains', 'Software'],
    ['github', 'GitHub', 'Developer tools'],
    ['gitlab', 'GitLab', 'Developer tools'],
    ['digitalocean', 'DigitalOcean', 'Hosting'],
    ['linode', 'Akamai/Linode', 'Hosting'],
    ['heroku', 'Heroku', 'Hosting'],
    ['vercel', 'Vercel', 'Hosting'],
    ['netlify', 'Netlify', 'Hosting'],
    ['cloudflare', 'Cloudflare', 'Hosting'],
    ['godaddy', 'GoDaddy', 'Hosting'],
    ['namecheap', 'Namecheap', 'Hosting'],
    ['squarespace', 'Squarespace', 'Hosting'],
    ['wix.com', 'Wix', 'Hosting'],
    ['wordpress', 'WordPress', 'Hosting'],
    ['shopify', 'Shopify', 'Business tools'],
    ['mailchimp', 'Mailchimp', 'Business tools'],
    ['hubspot', 'HubSpot', 'Business tools'],
    ['quickbooks', 'QuickBooks', 'Business tools'],
    ['xero', 'Xero', 'Business tools'],
    ['freshbooks', 'FreshBooks', 'Business tools'],
    ['docusign', 'DocuSign', 'Business tools'],
    ['calendly', 'Calendly', 'Business tools'],
    ['atlassian', 'Atlassian', 'Business tools'],
    ['aws', 'Amazon Web Services', 'Hosting'],
    ['amazon web services', 'Amazon Web Services', 'Hosting'],

    // AI
    ['openai', 'OpenAI', 'AI tools'],
    ['chatgpt', 'OpenAI', 'AI tools'],
    ['anthropic', 'Anthropic', 'AI tools'],
    ['claude.ai', 'Anthropic', 'AI tools'],
    ['midjourney', 'Midjourney', 'AI tools'],
    ['elevenlabs', 'ElevenLabs', 'AI tools'],
    ['perplexity', 'Perplexity', 'AI tools'],
    ['runway', 'Runway', 'AI tools'],
    ['cursor', 'Cursor', 'AI tools'],
    ['replit', 'Replit', 'Developer tools'],

    // shopping & marketplaces
    ['amazon prime', 'Amazon Prime', 'Memberships'],
    ['amzn prime', 'Amazon Prime', 'Memberships'],
    ['prime video', 'Prime Video', 'Streaming video'],
    ['amazon', 'Amazon', 'Shopping'],
    ['amzn', 'Amazon', 'Shopping'],
    ['ebay', 'eBay', 'Shopping'],
    ['etsy', 'Etsy', 'Shopping'],
    ['walmart', 'Walmart', 'Groceries'],
    ['target', 'Target', 'Shopping'],
    ['costco', 'Costco', 'Groceries'],
    ['ikea', 'IKEA', 'Shopping'],
    ['flipkart', 'Flipkart', 'Shopping'],
    ['aliexpress', 'AliExpress', 'Shopping'],
    ['temu', 'Temu', 'Shopping'],
    ['shein', 'SHEIN', 'Shopping'],

    // food
    ['uber eats', 'Uber Eats', 'Food delivery'],
    ['ubereats', 'Uber Eats', 'Food delivery'],
    ['doordash', 'DoorDash', 'Food delivery'],
    ['grubhub', 'Grubhub', 'Food delivery'],
    ['deliveroo', 'Deliveroo', 'Food delivery'],
    ['just eat', 'Just Eat', 'Food delivery'],
    ['instacart', 'Instacart', 'Groceries'],
    ['hellofresh', 'HelloFresh', 'Meal kits'],
    ['blue apron', 'Blue Apron', 'Meal kits'],
    ['gousto', 'Gousto', 'Meal kits'],
    ['zomato', 'Zomato', 'Food delivery'],
    ['swiggy', 'Swiggy', 'Food delivery'],
    ['starbucks', 'Starbucks', 'Coffee & cafes'],
    ['dunkin', 'Dunkin’', 'Coffee & cafes'],
    ['pret a manger', 'Pret A Manger', 'Coffee & cafes'],
    ['mcdonald', 'McDonald’s', 'Restaurants'],
    ['chipotle', 'Chipotle', 'Restaurants'],
    ['dominos', 'Domino’s', 'Restaurants'],
    ['whole foods', 'Whole Foods', 'Groceries'],
    ['trader joe', 'Trader Joe’s', 'Groceries'],
    ['tesco', 'Tesco', 'Groceries'],
    ['sainsbury', 'Sainsbury’s', 'Groceries'],
    ['aldi', 'Aldi', 'Groceries'],
    ['lidl', 'Lidl', 'Groceries'],
    ['kroger', 'Kroger', 'Groceries'],
    ['safeway', 'Safeway', 'Groceries'],

    // transport
    ['uber', 'Uber', 'Transport'],
    ['lyft', 'Lyft', 'Transport'],
    ['ola cabs', 'Ola', 'Transport'],
    ['shell', 'Shell', 'Fuel'],
    ['bp ', 'BP', 'Fuel'],
    ['chevron', 'Chevron', 'Fuel'],
    ['exxon', 'Exxon', 'Fuel'],
    ['transport for london', 'Transport for London', 'Transport'],
    ['tfl.gov', 'Transport for London', 'Transport'],

    // telecom & utilities
    ['verizon', 'Verizon', 'Phone & internet'],
    ['at&t', 'AT&T', 'Phone & internet'],
    ['t-mobile', 'T-Mobile', 'Phone & internet'],
    ['tmobile', 'T-Mobile', 'Phone & internet'],
    ['comcast', 'Comcast', 'Phone & internet'],
    ['xfinity', 'Xfinity', 'Phone & internet'],
    ['spectrum', 'Spectrum', 'Phone & internet'],
    ['vodafone', 'Vodafone', 'Phone & internet'],
    ['airtel', 'Airtel', 'Phone & internet'],
    ['jio', 'Jio', 'Phone & internet'],
    ['bt group', 'BT', 'Phone & internet'],
    ['sky digital', 'Sky', 'Phone & internet'],
    ['virgin media', 'Virgin Media', 'Phone & internet'],
    ['mint mobile', 'Mint Mobile', 'Phone & internet'],
    ['google fi', 'Google Fi', 'Phone & internet'],

    // fitness & health
    ['planet fitness', 'Planet Fitness', 'Fitness'],
    ['equinox', 'Equinox', 'Fitness'],
    ['peloton', 'Peloton', 'Fitness'],
    ['classpass', 'ClassPass', 'Fitness'],
    ['strava', 'Strava', 'Fitness'],
    ['whoop', 'WHOOP', 'Fitness'],
    ['fitbit', 'Fitbit', 'Fitness'],
    ['myfitnesspal', 'MyFitnessPal', 'Fitness'],
    ['calm.com', 'Calm', 'Health & wellbeing'],
    ['headspace', 'Headspace', 'Health & wellbeing'],
    ['noom', 'Noom', 'Health & wellbeing'],
    ['gymshark', 'Gymshark', 'Shopping'],
    ['la fitness', 'LA Fitness', 'Fitness'],
    ['pure gym', 'PureGym', 'Fitness'],
    ['cult.fit', 'Cult.fit', 'Fitness'],

    // gaming
    ['playstation', 'PlayStation', 'Gaming'],
    ['xbox', 'Xbox', 'Gaming'],
    ['nintendo', 'Nintendo', 'Gaming'],
    ['steam', 'Steam', 'Gaming'],
    ['steampowered', 'Steam', 'Gaming'],
    ['epic games', 'Epic Games', 'Gaming'],
    ['roblox', 'Roblox', 'Gaming'],
    ['ea games', 'EA', 'Gaming'],
    ['twitch', 'Twitch', 'Gaming'],
    ['discord', 'Discord', 'Gaming'],

    // news & learning
    ['new york times', 'New York Times', 'News & reading'],
    ['nytimes', 'New York Times', 'News & reading'],
    ['washington post', 'Washington Post', 'News & reading'],
    ['wall street journal', 'Wall Street Journal', 'News & reading'],
    ['the guardian', 'The Guardian', 'News & reading'],
    ['financial times', 'Financial Times', 'News & reading'],
    ['the economist', 'The Economist', 'News & reading'],
    ['medium.com', 'Medium', 'News & reading'],
    ['substack', 'Substack', 'News & reading'],
    ['patreon', 'Patreon', 'News & reading'],
    ['kindle unlimited', 'Kindle Unlimited', 'News & reading'],
    ['scribd', 'Scribd', 'News & reading'],
    ['coursera', 'Coursera', 'Education'],
    ['udemy', 'Udemy', 'Education'],
    ['skillshare', 'Skillshare', 'Education'],
    ['masterclass', 'MasterClass', 'Education'],
    ['duolingo', 'Duolingo', 'Education'],
    ['babbel', 'Babbel', 'Education'],
    ['linkedin', 'LinkedIn', 'Memberships'],
    ['chegg', 'Chegg', 'Education'],

    // financial & insurance
    ['geico', 'GEICO', 'Insurance'],
    ['progressive', 'Progressive', 'Insurance'],
    ['state farm', 'State Farm', 'Insurance'],
    ['allstate', 'Allstate', 'Insurance'],
    ['aviva', 'Aviva', 'Insurance'],
    ['admiral', 'Admiral', 'Insurance'],
    ['lemonade', 'Lemonade', 'Insurance'],
    ['experian', 'Experian', 'Financial services'],
    ['credit karma', 'Credit Karma', 'Financial services'],
    ['robinhood', 'Robinhood', 'Financial services'],
    ['coinbase', 'Coinbase', 'Financial services'],
    ['paypal', 'PayPal', 'Financial services'],
    ['venmo', 'Venmo', 'Financial services'],
    ['cash app', 'Cash App', 'Financial services'],
    ['wise ', 'Wise', 'Financial services'],
    ['revolut', 'Revolut', 'Financial services'],
    ['tradingview', 'TradingView', 'Financial services'],
    ['alpaca', 'Alpaca', 'Financial services'],

    // misc recurring
    ['dashpass', 'DashPass', 'Memberships'],
    ['aaa ', 'AAA', 'Memberships'],
    ['costco membership', 'Costco Membership', 'Memberships'],
    ['sams club', 'Sam’s Club', 'Memberships'],
    ['chewy', 'Chewy', 'Pets'],
    ['petco', 'Petco', 'Pets'],
    ['rover.com', 'Rover', 'Pets'],
    ['dollar shave', 'Dollar Shave Club', 'Personal care'],
    ['birchbox', 'Birchbox', 'Personal care'],
    ['stitch fix', 'Stitch Fix', 'Shopping'],
    ['storage', 'Self storage', 'Storage'],
    ['tinder', 'Tinder', 'Dating'],
    ['bumble', 'Bumble', 'Dating'],
    ['hinge', 'Hinge', 'Dating'],
    ['match.com', 'Match', 'Dating']
  ].sort(function (a, b) { return b[0].length - a[0].length; });

  /* Words that carry no identifying information once processors are stripped. */
  var STOPWORDS = new Set(['the', 'inc', 'llc', 'ltd', 'limited', 'co', 'corp',
    'company', 'plc', 'gmbh', 'bv', 'sa', 'pty', 'pvt', 'holdings', 'group',
    'intl', 'international', 'services', 'service', 'payment', 'payments',
    'subscription', 'subscr', 'monthly', 'annual', 'renewal', 'bill', 'billing',
    'online', 'web', 'store', 'shop', 'com', 'net', 'org', 'io', 'card', 'debit',
    'credit', 'transaction', 'purchase', 'auth', 'pending']);

  function clean(desc) {
    var s = String(desc || '').toLowerCase();
    s = s.replace(/[‘’“”]/g, "'");

    // Peel processor prefixes repeatedly — they nest, e.g. "POS DEBIT SQ *…".
    for (var i = 0; i < 4; i++) {
      var before = s;
      s = s.replace(PROCESSOR, '');
      if (s === before) break;
    }
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  }

  function stripNoise(s) {
    var out = s;
    NOISE.forEach(function (re) { out = out.replace(re, ' '); });
    out = out.replace(/[^a-z0-9&+' ]+/gi, ' ').replace(/\s+/g, ' ').trim();
    var words = out.split(' ').filter(function (w) {
      return w && !STOPWORDS.has(w) && !/^\d+$/.test(w);
    });
    return words.join(' ');
  }

  function titleCase(s) {
    return s.replace(/\w[^\s-]*/g, function (w) {
      if (w.length <= 3 && w === w.toUpperCase()) return w;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    });
  }

  /* Household bills rarely carry a recognisable brand — they are named after
     a local landlord or utility. Keywords catch the category even when the
     merchant is unknown, which is what lets bills be separated from
     subscriptions you could actually cancel. */
  var CATEGORY_HINTS = [
    [/\b(rent|landlord|property\s*mgmt|property\s*management|lettings|leasing|mortgage|hoa\b|homeowners\s*assoc)\b/, 'Housing'],
    [/\b(electric|energy|power\s*co|utility|utilities|water\s*(co|dept|board)|sewer|gas\s*(co|company|bill)|council\s*tax|edison|con\s*ed|npower|octopus\s*energy|british\s*gas)\b/, 'Utilities'],
    [/\b(insurance|assurance|life\s*cover|policy\s*premium)\b/, 'Insurance'],
    [/\b(childcare|nursery|daycare|preschool|tuition|school\s*fees)\b/, 'Childcare & school'],
    [/\b(loan|repayment|finance\s*pmt|hp\s*agreement|student\s*loan)\b/, 'Loans & credit'],
    [/\b(gym|fitness|leisure\s*centre)\b/, 'Fitness'],
    [/\b(broadband|internet|mobile|wireless|telecom)\b/, 'Phone & internet']
  ];

  /* Resolve one descriptor to {name, category, matched}. */
  function resolve(desc) {
    var cleaned = clean(desc);
    for (var i = 0; i < KNOWN.length; i++) {
      if (cleaned.indexOf(KNOWN[i][0]) !== -1) {
        return { name: KNOWN[i][1], category: KNOWN[i][2], matched: true };
      }
    }
    for (var h = 0; h < CATEGORY_HINTS.length; h++) {
      if (CATEGORY_HINTS[h][0].test(cleaned)) {
        var lbl = stripNoise(cleaned).split(' ').slice(0, 4).join(' ');
        return {
          name: titleCase(lbl || cleaned.slice(0, 28)),
          category: CATEGORY_HINTS[h][1], matched: false
        };
      }
    }
    var stripped = stripNoise(cleaned);
    if (!stripped) stripped = cleaned.replace(/[^a-z0-9 ]+/gi, ' ').trim();
    if (!stripped) return { name: '(unrecognised)', category: 'Other', matched: false };

    // Keep it short — the first few words carry the identity.
    var label = stripped.split(' ').slice(0, 4).join(' ');
    return { name: titleCase(label), category: 'Other', matched: false };
  }

  /* Names that came from the known-merchant table are deliberately distinct
     products and must never be folded together — "Amazon Prime" is not
     "Amazon", "Google One" is not "Google", "Apple Music" is not "Apple". */
  var CANONICAL = new Set(KNOWN.map(function (k) { return k[1]; }));

  /* Second pass: merge merchants whose cleaned keys are prefixes of one
     another, so "Blue Bottle" and "Blue Bottle Coffee" become one entity.
     Only applied to names Drip had to guess from raw statement text, which is
     where that messiness actually comes from. */
  function mergeSimilar(names) {
    var keys = names.filter(function (n) { return !CANONICAL.has(n); })
      .map(function (n) {
        return { orig: n, key: n.toLowerCase().replace(/[^a-z0-9]/g, '') };
      }).sort(function (a, b) { return a.key.length - b.key.length; });

    var map = {};
    names.forEach(function (n) { map[n] = n; });

    keys.forEach(function (k) {
      if (!k.key) return;
      for (var i = 0; i < keys.length; i++) {
        var other = keys[i];
        if (other.orig === k.orig || !other.key) continue;
        if (other.key.length < k.key.length &&
            k.key.indexOf(other.key) === 0 && other.key.length >= 5) {
          map[k.orig] = map[other.orig] || other.orig;
          return;
        }
      }
    });
    return map;
  }

  global.DripMerchants = {
    resolve: resolve,
    mergeSimilar: mergeSimilar,
    clean: clean,
    knownCount: KNOWN.length
  };
})(window);
