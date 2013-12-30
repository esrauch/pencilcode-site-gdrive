var express = require('express'),
    utils = require('connect').utils,
    path = require('path'),
    http = require('http'),
    url = require('url'),
    httpProxy = require('http-proxy'),
    app = module.exports = express(),
    proxy = new httpProxy.RoutingProxy();

function rewriteRules(req, res, next) {
  var u = utils.parseUrl(req);
  if (u.pathname == '/') { u.pathname = '/welcome.html'; }
  else if (/^\/edit\//.test(u.pathname)) { u.pathname = '/editor.html'; }
  else if (/^\/home(?=\/).*\/$/.test(u.pathname)) { u.pathname = '/dir.html'; }
  else { next(); return; }
  req.url = url.format(u);
  next();
}

function proxyRules(req, res, next) {
  var u = utils.parseUrl(req);
  if (/^\/(?:home|load|save)(?=\/)/.test(u.pathname) &&
      /\.dev$/.test(u.host)) {
    var host = req.headers['host'] = u.host.replace(/\.dev$/, '');
    req.headers['url'] = u.path;
    proxy.proxyRequest(req, res, {
      host: host,
      port: 80,
      enable: { xforward: true }
    });
  } else {
    next();
  }
}

function proxyPacGenerator(req, res, next) {
  var u = utils.parseUrl(req);
  if (u.pathname == '/proxy.pac') {
    var hostHeader = req.get('host'),
        hostMatch = /^([^:]+)(?::(\d*))?$/.exec(hostHeader || ''),
        hostDomain = hostMatch[1] || 'localhost',
        hostPort = hostMatch[2] || app.get('port');
    res.writeHead(200, {
        'Content-Type': 'application/x-javascript-config'
    });
    res.end(
        'function FindProxyForURL(url, host) {\n' +
        ' if (shExpMatch(host, "*.dev")) {\n' +
        '  return "PROXY ' + hostDomain + ':' + hostPort + '";\n' +
        ' }\n' +
        ' return "DIRECT";\n' +
        '}\n'
    );
  } else {
    next();
  }
}

app.configure(function() {
  app.set('port', process.env.PORT || 8088);
  app.use(rewriteRules);
  app.use(express.static(path.join(__dirname, '../site/top')));
  app.use(proxyRules);
  app.use(proxyPacGenerator);
  app.get('*', function(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('404 - ' + req.url);
  });
});
