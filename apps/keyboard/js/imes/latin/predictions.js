/* -*- Mode: js; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- /
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */

// JavaScript predictive text engine.
//
// A note on the dictionary format: The prediction engine uses a custom binary
// dictionary format that is generated by xml2dict.py from a XML-based word
// lists. The word lists included with this engine are minimally modified
// versions of the word lists that ship with Android Jelly Bean (4.1). The
// lists are licensed under the Apache license, as is this engine.
//
// Consult xml2dict.py to understand the format of the dictionary file. The
// purpose of the dictionary file is to compactly represent the ternary
// search tree.
// We use the binary representation of the tst instead of building a tst
// out of JS objects because JS objects tend to occupy much
// more memory than the binary format xml2dict.py generates.
//
// This module defines a single global variable Predictions which is an
// object with the following methods:
//
//   setDictionary: specifies the dictionary to use
//
//   setLayout: specifies the keyboard layout, which is used to
//      determine the set of nearby keys for each key
//
//   predict: given an input string, return the most likely
//      completions or corrections for it.
//
'use strict';

var Predictions = function() {
  var _dict;
  var _nearbyKeys; // nearby keys for any given key
  var _maxSuggestions = 3; // max number of suggestions to be returned
  var _nodeSize = 7; // the size of a node is 7 * 2 bytes
  var _suggestions = []; // the found suggestions
  var _candidates = [];
  var _suggestions_index = {}; // indexed by suggestion (to remove duplicates)
  var _diacritics = {}; // mapping from accented to non-accented letters

  // Send a log message to the main thread since we can't output to the console
  // directly.
  function log(msg) {
    self.postMessage({ cmd: 'log', args: [msg] });
  }

  // Calculate the squared distance of a point (x, y) to the nearest edge of
  // a rectangle (left, top, width, height). This is used to calculate the
  // nearby keys for every key. We search the dictionary by looking for words
  // where each character corresponds to the key the user touched, or a key
  // near that key.
  function SquaredDistanceToEdge(left, top, width, height, x, y) {
    var right = left + width;
    var bottom = top + height;
    var edgeX = x < left ? left : (x > right ? right : x);
    var edgeY = y < top ? top : (y > bottom ? bottom : y);
    var dx = x - edgeX;
    var dy = y - edgeY;
    return dx * dx + dy * dy;
  }

  // Determine whether the key is a special character or a regular letter.
  // Special characters include backspace (8), return (13), and space (32).
  function SpecialKey(key) {
    var code = key.code;
    // codes: 'a' = 97, 'z' = 122
    return code < 97 || code > 122;
  }

  function setDictionary(dict) {
    _dict = Uint16Array(dict);
  }

  function setLayout(params) {
    // For each key, calculate the keys nearby.
    var keyWidth = params.keyWidth;
    var keyHeight = params.keyHeight;
    var threshold = Math.min(keyWidth, keyHeight) * 1.2;
    var keyArray = params.keyArray;
    _nearbyKeys = {};
    threshold *= threshold;
    for (var n = 0; n < keyArray.length; ++n) {
      var key1 = keyArray[n];
      if (SpecialKey(key1))
        continue;
      var list = {};
      for (var m = 0; m < keyArray.length; ++m) {
        var key2 = keyArray[m];
        if (SpecialKey(key2))
          continue;
        if (SquaredDistanceToEdge(/* key dimensions */
          key1.x, key1.y,
          key1.width, key1.height,
          /* center of candidate key */
          key2.x + key2.width / 2,
          key2.y + key2.height / 2) <
            threshold) {
          list[String.fromCharCode(key2.code).toLowerCase()] = true;
        }
      }
      _nearbyKeys[String.fromCharCode(key1.code).toLowerCase()] = list;
    }
    // Fill the diacritics array
    var diacritics = {
      'a': 'ÁáĂăǍǎÂâÄäȦȧẠạȀȁÀàẢảȂȃĀāĄąÅåḀḁȺⱥÃãǼǽǢǣÆæ',
      'b': 'ḂḃḄḅƁɓḆḇɃƀƂƃ',
      'c': 'ĆćČčÇçĈĉĊċƇƈȻȼ',
      'd': 'ĎďḐḑḒḓḊḋḌḍƊɗḎḏĐđƋƌð',
      'e': 'ÉéĔĕĚěȨȩÊêḘḙËëĖėẸẹȄȅÈèẺẻȆȇĒēĘę',
      'f': 'ḞḟƑƒ',
      'g': 'ǴǵĞğǦǧĢģĜĝĠġƓɠḠḡǤǥ',
      'h': 'ḪḫȞȟḨḩĤĥⱧⱨḦḧḢḣḤḥĦħ',
      'i': 'ÍíĬĭǏǐÎîÏïỊịȈȉÌìỈỉȊȋĪīĮįƗɨĨĩḬḭı',
      'j': 'ĴĵɈɉ',
      'k': 'ḰḱǨǩĶķⱩⱪꝂꝃḲḳƘƙḴḵꝀꝁ',
      'l': 'ĹĺȽƚĽľĻļḼḽḶḷⱠⱡꝈꝉḺḻĿŀⱢɫŁł',
      'm': 'ḾḿṀṁṂṃⱮɱ',
      'n': 'ŃńŇňŅņṊṋṄṅṆṇǸǹƝɲṈṉȠƞÑñ',
      'o': 'ÓóŎŏǑǒÔôÖöȮȯỌọŐőȌȍÒòỎỏƠơȎȏꝊꝋꝌꝍŌōǪǫØøÕõŒœ',
      'p': 'ṔṕṖṗꝒꝓƤƥⱣᵽꝐꝑ',
      'q': 'Ꝗꝗ',
      'r': 'ŔŕŘřŖŗṘṙṚṛȐȑȒȓṞṟɌɍⱤɽ',
      's': 'ŚśŠšŞşŜŝȘșṠṡṢṣß$',
      't': 'ŤťŢţṰṱȚțȾⱦṪṫṬṭƬƭṮṯƮʈŦŧ',
      'u': 'ÚúŬŭǓǔÛûṶṷÜüṲṳỤụŰűȔȕÙùỦủƯưȖȗŪūŲųŮůŨũṴṵ',
      'v': 'ṾṿƲʋṼṽ',
      'w': 'ẂẃŴŵẄẅẆẇẈẉẀẁⱲⱳ',
      'x': 'ẌẍẊẋ',
      'y': 'ÝýŶŷŸÿẎẏỴỵỲỳƳƴỶỷỾỿȲȳɎɏỸỹ',
      'z': 'ŹźŽžẐẑⱫⱬŻżẒẓȤȥẔẕƵƶ'
    };
    for (var letter in diacritics) {
      var s = diacritics[letter];
      for (var i = 0, len = s.length; i < len; i++)
        _diacritics[s[i]] = letter;
    }
  }

  function readNode(offset, node) {
    if (offset == 0) {
      node.active = false;
      return;
    }
    offset = (offset - 1) * _nodeSize;
    var high = _dict[offset + 5];

    node.active = true;
    node.ch = _dict[offset];
    node.lPtr = _dict[offset + 1] | (high & 0xf000) << 4;
    node.cPtr = _dict[offset + 2] | (high & 0xf00) << 8;
    node.rPtr = _dict[offset + 3] | (high & 0xf0) << 12;
    node.nPtr = _dict[offset + 4] | (high & 0xf) << 16;
    node.freq = _dict[offset + 6];
  }

  // Find the end of the prefix (exact match)
  function findExactly(offset, result, prefix) {
    var i = 0, prefixLen = prefix.length;
    var node = Object.create(null);
    readNode(offset, node);
    while (node.active) {
      if (prefixLen == i) {
        // The prefix was found; add the node to candidates
        addNextCandidate(offset, result + prefix, 1);
        return;
      }
      var ch = prefix.charCodeAt(i);
      if (ch < node.ch)
        offset = node.lPtr;
      else if (ch > node.ch)
        offset = node.rPtr;
      else {
        i++;
        offset = node.cPtr;
      }
      readNode(offset, node);
    }
  }

  // Remove the distinction between lowercase/uppercase letters and diacritics
  function normalize(ch) {
    ch = ch.toLowerCase();
    if (ch in _diacritics)
      ch = _diacritics[ch];
    return ch;
  }

  function findFuzzy(offset, result, prefix) {
    var node = Object.create(null);
    readNode(offset, node);
    if (prefix.length == 0) {
      if (node.active) // Found the exact match
        // If the prefix matches, increase frequency of this candidate.
        // If the word is short, increase it greatly to filter out fuzzy
        // matches (e.g., "or" and "of" when typing "on"). If the word is long,
        // assume that user can mistype it (and allow fuzzy matches).
        addNextCandidate(offset, result, 1 + 3 / result.length);
      return;
    }

    if (!node.active)
      return;
    if (prefix.length == 1) // try to delete the last character
      addNextCandidate(offset, result, 1);

    // Try the fuzzy matches that are better (earlier in nPtr list)
    // that the exact match.
    while (node.active) {
      var nodeChar = String.fromCharCode(node.ch);
      if (normalize(nodeChar) == normalize(prefix[0])) {
        do {
          findFuzzy(node.cPtr, result + nodeChar, prefix.substr(1));
          readNode(node.nPtr, node);
          if (!node.active)
            return;
          nodeChar = String.fromCharCode(node.ch);
        } while (normalize(nodeChar) == normalize(prefix[0]));
        // If there are enough candidates, finish the search without
        // viewing the fuzzy matches that are worse than the exact match.
        if (_candidates.length >= _maxSuggestions)
          return;
        continue;
      }
      if (node.cPtr) {
        var res = result + nodeChar;

        findExactly(node.cPtr, res, prefix); // insert a character

        // replace a character
        if (prefix[0] in _nearbyKeys && nodeChar in _nearbyKeys[prefix[0]]) {
          findExactly(node.cPtr, res, prefix.substr(1));
        }

        if (prefix.length > 1 && nodeChar == prefix[1]) {
          // transpose
          findExactly(node.cPtr, res, prefix[0] + prefix.substr(2));
          // delete
          findExactly(node.cPtr, res, prefix.substr(2));
        }
      }
      readNode(node.nPtr, node);
    }
  }

  function addNextCandidate(offset, prefix, multiplier) {
    var node = Object.create(null);
    readNode(offset, node);
    var i = _candidates.length - 1;
    // Find the insertion point
    var freq = node.freq * multiplier;
    while (i >= 0 && freq > _candidates[i].freq)
      i--;
    // Don't insert a candidate that is worse than already found candidates
    // if we already have the required number of candidates
    if (i == _candidates.length - 1 && _candidates.length >= _maxSuggestions)
      return;
    _candidates.splice(i + 1, 0, { node: node, prefix: prefix,
      multiplier: multiplier, freq: node.freq * multiplier });
  }

  function predictSuffixes() {
    while (_candidates.length > 0 && _suggestions.length < _maxSuggestions) {
      var cand = _candidates.shift();
      var node = cand.node;
      var prefix = cand.prefix;
      for (;;) {
        if (node.nPtr) // Add the next best candidate
          addNextCandidate(node.nPtr, prefix, cand.multiplier);

        if (node.ch == 0) // If the word ends here
          break;

        // Move to the next character in the best candidate
        prefix += String.fromCharCode(node.ch);
        readNode(node.cPtr, node);
      }
      // Record the suggestion and move to the next best candidate
      if (!(prefix in _suggestions_index)) {
        _suggestions.push(prefix);
        _suggestions_index[prefix] = true;
      }
    }
  }

  function predict(prefix) {
    if (!_dict || !_nearbyKeys)
      throw Error('not initialized');

    _suggestions = [];
    _candidates = [];
    _suggestions_index = Object.create(null);
    findFuzzy(1, '', prefix);
    predictSuffixes();
    return _suggestions;
  }

  return {
    setDictionary: setDictionary,
    setLayout: setLayout,
    predict: predict
  };
}();
