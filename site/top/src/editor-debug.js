//////////////////////////////////////////////////////////////////////////r
// DEBUGGER SUPPORT
///////////////////////////////////////////////////////////////////////////

define([
  'jquery',
  'editor-view',
  'see',
  'sourcemap/source-map-consumer'],
function($, view, see, sourcemap) {

eval(see.scope('debug'));

var targetWindow = null;    // window object of the frame being debugged.
var nextDebugId = 1;        // a never-decreasing sequence of debug event ids.
var firstSessionId = 1;     // the first id of the current running session.
var debugIdException = {};  // map debug ids -> exception objects.
var debugIdRecord = {};     // map debug ids -> line execution records.
var lineRecord = {};        // map line numbers -> line execution records.
var everyRecord = [];       // a sequence of all records from the run.
var cachedSourceMaps = {};  // parsed source maps for currently-running code.
var cachedParsedStack = {}; // parsed stack traces for currently-running code.

// Resets the debugger state:
// Remembers the targetWindow, and clears all logged debug records.
// Calling bindframe also resets firstSessionId, so that callbacks
// having to do with previous sessions are ignored.
function bindframe(w) {
  targetWindow = w;
  debugIdException = {};
  debugIdRecord = {};
  lineRecord = {};
  everyRecord = [];
  cachedSourceMaps = {};
  cachedParseStack = {};
  view.clearPaneEditorMarks(view.paneid('left'));
  firstSessionId = nextDebugId;
}

// Exported functions from the edit-debug module are exposed
// as the top frame's "ide" global variable.
var debug = window.ide = {
  nextId: function() {
    debugIdException[nextDebugId] = createError();
    return nextDebugId++;
  },
  bindframe: bindframe,
  reportEvent: function(name, data) {
    if (!targetWindow) {
      return;
    }
    $(debug).trigger(name, data);
  },
};

// The "enter" event is triggered inside the call to a turtle command.
// There is exactly one enter event for each debugId, and each corresponds
// to exactly one call of the turtle method (with method and args as passed).
// Enter is the first event triggered, and it is always matched by one exit.
// Appear and resolve will appear between enter and exit if the action is
// synchronous.  The "length" parameter indicates the number of appear
// (and matching resolve) events to expect for this debugId.
$(debug).on('enter',
function debugEnter(event, method, debugId, length, args) {
  var record = getDebugRecord(method, debugId, length, args);
  if (!record) { return; }
  updateLine(record);
});

// The exit event is triggered when the call to the turtle command is done.
$(debug).on('exit',
function debugExit(event, method, debugId, length, args) {
  var record = getDebugRecord(method, debugId, length, args);
  if (!record) { return; }
  record.exited = true;
  updateLine(record);
});

// The appear event is triggered when the visible animation for a turtle
// command begins.  If the animation happens asynchronously, appear is
// triggered after exit; but if the animation happens synchronously,
// it can precede exit.  Arguments are the same as for start, except
// the "index" and "element" arguments indicate the element which is
// being animated, and its index in the list of animated elements.
$(debug).on('appear',
function debugAppear(event, method, debugId, length, index, elem, args) {
  var record = getDebugRecord(method, debugId, length, args);
  if (!record) { return; }
  record.appearCount += 1;
  record.startCoords[index] = collectCoords(elem);
  updateLine(record);
});

// The resolve event is triggered when the visible animation for a turtle
// command ends.  It always happens after the corresponding "appear"
// event, but may occur before or after "start".
$(debug).on('resolve',
function debugResolve(event, method, debugId, length, index, elem) {
  var record = debugIdRecord[debugId];
  if (!record) { return; }
  record.resolveCount += 1;
  record.endCoords[index] = collectCoords(elem);
  if (record.resolveCount > record.appearCount) {
    console.trace('Error: more resolve than appear events');
  }
  if (record.resolveCount > record.totalCount) {
    console.trace('Error: too many resolve events', record);
  }
  updateLine(record);
});

// The error event is triggered when an uncaught exception occurs.
// The err object is an exception or an Event object corresponding
// to the error.
$(debug).on('error',
function debugError(event, err) {
  var line = editorLineNumberForError(err);
  view.clearPaneEditorMarks(view.paneid('left'), 'debugerror');
  view.markPaneEditorLine(view.paneid('left'), line, 'debugerror');
});

// Retrieves (or creates if necessary) the debug record corresponding
// to the given debugId.  A debug record tracks everything needed for
// rendering information about a snapshot in time in the debugger:
// which function was called, the location of the elements being
// affected, and so on.  This function only deals with the table
// debugIdRecord.
function getDebugRecord(method, debugId, length, args) {
  if (debugId in debugIdRecord) {
    return debugIdRecord[debugId];
  }
  if (debugId < firstSessionId) {
    return null;
  }
  var record = debugIdRecord[debugId] = {
    method: method,
    traced: false,
    exited: false,
    exception: debugIdException[debugId],
    line: null,
    debugId: debugId,
    totalCount: length,
    appearCount: 0,
    resolveCount: 0,
    startCoords: [],
    endCoords: [],
    args: args
  };
  return record;
}

// After a debug record has been created or updated, updateLine
// determines whether the corresponding line of source code should
// be highlighted or unhighlighted, and if so, it does the highlighting.
// This function maintains the record.traced bit and the lineRecord map.
function updateLine(record) {
  if (!record || record.debugId < firstSessionId) {
    return;
  }
  // Optimization: only compute line number when there is a visible
  // async animation.
  if (record.line == null && record.exception && record.exited &&
      record.appearCount > record.resolveCount) {
    record.line = editorLineNumberForError(record.exception);
  }
  if (record.line != null) {
    var oldRecord = lineRecord[record.line];
    if (record.appearCount > record.resolveCount) {
      lineRecord[record.line] = record;
      if (!oldRecord || !oldRecord.traced) {
        traceLine(record.line);
      }
      record.traced = true;
    } else {
      if (!oldRecord || !oldRecord.appearCount || oldRecord === record) {
        lineRecord[record.line] = record;
        if (oldRecord && oldRecord.traced) {
          untraceLine(record.line);
        }
      }
      record.traced = false;
    }
  }
  // Should we garbage-collect?  Here we do:
  if (record.resolveCount >= record.totalCount &&
      record.resolveCount >= record.appearCount &&
      record.exited) {
    delete debugIdRecord[record.debugId];
  }
}

// Used while logging animations (during the 'appear' and 'resolve'
// events) to grab information off an element that allows us to later
// compute the coordinates.
function collectCoords(elem) {
  try {
    // TODO: when the element is not a turtle with the standard
    // parent element positioning, we should do a slower operation to
    // grab the absolute position and direction.
    return {
      transform: elem.style[targetWindow.jQuery.support.transform]
    };
  } catch (e) {
    return null;
  }
}

// Creates an error object in order to collect a stack trace.
function createError() {
  try {
    Error.stackTraceLimit = 20;
    (null)();
  } catch(e) {
    return e;
  }
  return new Error();
}

// Highlights the given line number as a line being traced.
function traceLine(line) {
  view.markPaneEditorLine(view.paneid('left'), line, 'debugtrace');
}

// Unhighlights the given line number as a line no longer being traced.
function untraceLine(line) {
  view.clearPaneEditorLine(view.paneid('left'), line, 'debugtrace');
}


// parsestack converts an Error or ErrorEvent object into the following
// JSON structure.  Starting from the deepest call, it returns an array
// of tuples, each one representing a call in the call stack:
// [
//   {
//     method: (methodname),
//     file: (filename),
//     line: (one-based-linenumber),
//     column: (one-based-columnnumber)
//   },...
// ]
// Fields that are unknown are present but with value undefined or null.
function parsestack(err) {
  if (!(err instanceof targetWindow.Error) && err.error) {
    // As of 2013-07-24, the HTML5 standard specifies that ErrorEvents
    // contain an "error" property.  This test allows such objects
    // (and any objects with an error property) to be passed and unwrapped.
    // http://html5.org/tools/web-apps-tracker?from=8085&to=8086
    err = err.error;
  }
  var parsed = [], lines, j, line;
  // This code currently only works on Chrome.
  // TODO: add support for parsing other browsers' call stacks.
  if (err.stack) {
    var cached = cachedParseStack[err.stack];
    if (cached) {
      return cached;
    }
    lines = err.stack.split('\n');
    for (j = 0; j < lines.length; ++j) {
      line = lines[j];
      // We are interested only in lines starting with "at "
      if (!/^\s*at\s/.test(line)) continue;
      line = line.replace(/^\s*at\s+/, '');
      // Parse the call as printed by CallSiteToString(message.js) in Chrome.
      // Example: "Type.method (filename.js:43:1)"
      var methodname = null;
      // First, strip off filename/line number if present in parens.
      var parenpat = /\s+\((.*?)(?::(\d+)(?::(\d+))?)?\)$/;
      var locationmatch = parenpat.exec(line);
      if (locationmatch) {
        methodname = line.replace(parenpat, '');
      } else {
        locationmatch = /\s*(.*?)(?::(\d+)(?::(\d+))?)?$/.exec(line);
      }
      parsed.push({
        method: methodname,
        file: locationmatch[1],
        line: locationmatch[2] && parseInt(locationmatch[2]),
        column: locationmatch[3] && parseInt(locationmatch[3])
      });
    }
    cachedParseStack[err.stack] = parsed;
  }
  return parsed;
}

// Constructs a SourceMapConsumer object that can map from
// Javascript (stack trace) line numbers to CoffeeScript (user code)
// line numbers.  Since it takes some time to parse and construct
// this mapping, the results are cached.
function sourceMapConsumerForFile(file) {
  var result = cachedSourceMaps[file];
  if (!result) {
    var map = targetWindow.CoffeeScript.code[file].map;
    if (!map) return null;
    result = cachedSourceMaps[file] = new sourcemap.SourceMapConsumer(map);
  }
  return result;
}

// Returns the (1-based) line number for an error object, if any;
// or returns null if none can be figured out.
function editorLineNumberForError(error) {
  if (!error) return null;
  var parsed = parsestack(error);
  if (!parsed) return null;
  if (!targetWindow || !targetWindow.CoffeeScript ||
      !targetWindow.CoffeeScript.code) return null;
  // Find the innermost call that corresponds to compiled CoffeeScript.
  var frame = null;
  for (var j = 0; j < parsed.length; ++j) {
    if (parsed[j].file in targetWindow.CoffeeScript.code) {
      frame = parsed[j];
      break;
    }
  }
  // For debugging:
  // console.log(JSON.stringify(parsed), '>>>>', JSON.stringify(frame));
  if (!frame) return null;
  var smc = sourceMapConsumerForFile(frame.file);
  /* For debugging:
  var lines = targetWindow.CoffeeScript.code[frame.file].js.split('\n');
  for (var j = 0; j < lines.length; ++j) {
    console.log(j + 2, lines[j]);
  }
  smc.eachMapping(function(m) {
    console.log(JSON.stringify(m));
  });
  */

  // The CoffeeScript source code mappings are empirically a bit inaccurate,
  // but it seems if we scan forward to find a line number that isn't pinned
  // to the starting boilerplate, we can get a line number that seems
  // to be fairly accurate.
  var line = null;
  for (var col = Math.max(frame.column - 1, 0);
       col < Math.max(frame.column + 80, 80); col++) {
    var mapped = smc.originalPositionFor({line: frame.line, column: col});
    if (mapped && mapped.line && mapped.line >= 4) {
      line = mapped.line;
      break;
    }
  }

  if (!line || line < 4) return null;
  // Subtract a few lines of boilerplate from the top of the script.
  return line - 3;
}

//////////////////////////////////////////////////////////////////////
// GUTTER HIGHLIGHTING SUPPORT
//////////////////////////////////////////////////////////////////////
view.on('entergutter', function(pane, lineno) {
  if (pane != view.paneid('left')) return;
  if (!(lineno in lineRecord)) return;
  view.clearPaneEditorMarks(view.paneid('left'), 'debugfocus');
  view.markPaneEditorLine(view.paneid('left'), lineno, 'debugfocus');
  displayProtractorForRecord(lineRecord[lineno]);
});

view.on('leavegutter', function(pane, lineno) {
  view.clearPaneEditorMarks(view.paneid('left'), 'debugfocus');
  view.hideProtractor(view.paneid('right'));
});

function displayProtractorForRecord(record) {
  if (record.startCoords.length <= 0) return;
  var coords = record.endCoords[record.startCoords.length - 1];
  if (!coords || !coords.transform) return;
  var parsed = parseTurtleTransform(coords.transform);
  if (!parsed) return;
  // TODO: generalize this for turtles that are not in the main field.
  var origin = scope.jQuery('#field').offset();
  if (!origin) return;
  view.showProtractor(view.paneid('right'),
     origin.left + parsed.tx,
     origin.top + parsed.ty,
     parsed.rot,
     30);
}

// The canonical 2D transforms written by this plugin have the form:
// translate(tx, ty) rotate(rot) scale(sx, sy) rotate(twi)
// (with each component optional).
// This function quickly parses this form into a canonicalized object.
function parseTurtleTransform(transform) {
  if (transform === 'none') {
    return {tx: 0, ty: 0, rot: 0, sx: 1, sy: 1, twi: 0};
  }
  // Note that although the CSS spec doesn't allow 'e' in numbers, IE10
  // and FF put them in there; so allow them.
  var e = /^(?:translate\(([\-+.\de]+)(?:px)?,\s*([\-+.\de]+)(?:px)?\)\s*)?(?:rotate\(([\-+.\de]+)(?:deg)?\)\s*)?(?:scale\(([\-+.\de]+)(?:,\s*([\-+.\de]+))?\)\s*)?(?:rotate\(([\-+.\de]+)(?:deg)?\)\s*)?$/.exec(transform);
  if (!e) { return null; }
  var tx = e[1] ? parseFloat(e[1]) : 0,
      ty = e[2] ? parseFloat(e[2]) : 0,
      rot = e[3] ? parseFloat(e[3]) : 0,
      sx = e[4] ? parseFloat(e[4]) : 1,
      sy = e[5] ? parseFloat(e[5]) : sx,
      twi = e[6] ? parseFloat(e[6]) : 0;
  return {tx:tx, ty:ty, rot:rot, sx:sx, sy:sy, twi:twi};
}

return debug;

});