/**
 * A proxy server built with node.js and tailored to the ArcGIS platform. See README for description
 * of functionality and configuration.
 *
 * John's to-do list:
 * X test hostRedirect test with http://local.arcgis.com:3333/proxy/geo.arcgis.com/ArcGIS/rest/info/
 * * http://route.arcgis.com/arcgis/rest/services/World/ClosestFacility/NAServer/ClosestFacility_World/solveClosestFacility => http://local.arcgis.com:3333/proxy/http/route.arcgis.com/arcgis/rest/services/World/ClosestFacility/NAServer/ClosestFacility_World/solveClosestFacility?f=json
 *
 * * transform application/vnd.ogc.wms_xml to text/xml
 * * Resolving query parameters, combining query parameters from serverURL and request then replacing token
 * * adding token to request without a token
 * * replace token to a request that has a token but we dont want to use it
 * * If proxied request fails due to 499/498, catching that and retry with credentials or refresh token
 * * username/password
 * * tokenServiceUri
 * * oauth, clientId, clientSecret, oauthEndpoint, accessToken
 * * GET making sure all the query parameters are correct
 * * POST
 * * FILES
 */

const proxyVersion = "0.1.3";
const http = require('http');
const https = require('https');
const httpProxy = require('http-proxy');
const fs = require('fs');
const path = require('path');
const urlParser = require('url');
const BufferHelper = require('bufferhelper');
const OS = require('os');
const RateMeter = require('./RateMeter');
const ProjectUtilities = require('./ProjectUtilities');
const QuickLogger = require('./QuickLogger');
const UrlFlexParser = require('./UrlFlexParser');
const Configuration = require('./Configuration');


const defaultOAuthEndPoint = 'https://www.arcgis.com/sharing/oauth2/';

var configuration = Configuration.configuration;
var httpServer;
var proxyServer;
var rateMeter = null;
var serverStartTime = null;
var attemptedRequests = 0;
var validProcessedRequests = 0;
var errorProcessedRequests = 0;
var configurationComplete = false;
var waitingToRunIntegrationTests = false;


/**
 * Look up the urlRequested in the serverUrls configuration and return the matching object.
 * @param urlRequestedParts the object returns from parseURLRequest()
 * @returns {object} null if no match, otherwise the parsed and corrected URL scheme to proxy to.
 */
function getServerUrlInfo (urlRequestedParts) {
    var i,
        urlParts,
        serverUrls,
        serverUrl,
        serverUrlMatched = null;

    if (urlRequestedParts.proxyPath == null || urlRequestedParts.proxyPath == '') {
        return serverUrlMatched;
    }
    // clean and normalize the path we receive so it looks like a standard URL pattern. This usually means
    // translating /host.domain.tld/path/path into something else.
    urlParts = UrlFlexParser.parseAndFixURLParts(urlRequestedParts.proxyPath);
    serverUrls = configuration.serverUrls;
    urlParts.protocol = urlRequestedParts.protocol;
    if (urlParts.protocol.charAt(urlParts.protocol.length - 1) == ':') {
        urlParts.protocol = urlParts.protocol.substr(0, urlParts.protocol.length - 1);
    }
    if (urlParts.path == null || urlParts.path == '') {
        urlParts.path = urlRequestedParts.proxyPath;
    }
    // if we don't parse a host name then we are going to assume the host name is encoded in the path,
    // then take that piece out of the path
    if (urlParts.hostname == null || urlParts.hostname == '') {
        urlParts.hostname = urlParts.path;
        while (urlParts.hostname.length > 1 && urlParts.hostname.charAt(0) == '/') {
            urlParts.hostname = urlParts.hostname.substr(1);
        }
        i = urlParts.hostname.indexOf('/');
        if (i >= 0) {
            urlParts.path = urlParts.hostname.substr(i);
            urlParts.hostname = urlParts.hostname.substr(0, i);
        }
        urlParts.path = urlParts.path.replace(urlParts.hostname, '');
    }
    if (urlParts.port == null || urlParts.port == '') {
        urlParts.port = '*';
    }
    if (urlParts.query == null) {
        urlParts.query = urlRequestedParts.query;
    }
    for (i = 0; i < serverUrls.length; i ++) {
        serverUrl = serverUrls[i];
        if (UrlFlexParser.parsedUrlPartsMatch(urlParts, serverUrl)) { // (matchAll && urlRequested == serverUrl.url) || ( ! matchAll && startsWith(serverUrl.url, urlRequested))) {
            QuickLogger.logInfoEvent('getServerUrlInfo ' + urlRequestedParts.proxyPath + ' matching ' + serverUrl.url);
            serverUrlMatched = serverUrl;
            break;
        } else {
            QuickLogger.logInfoEvent('getServerUrlInfo ' + urlRequestedParts.proxyPath + ' no match ' + serverUrl.url);
        }
    }
    return serverUrlMatched;
}

/**
 * Determine if the URI requested is one of the URIs we are supposed to be listening for in listenURI[].
 * On the node.js server we can listen on any URI request we must specify the path we will accept.
 * If mustMatch is false then we will listen for anything! (Not sure if this is really useful.)
 * @param uri the uri that is being requested. Look this up in the serviceURLs table to make sure it is
 *    something we are supposed to service. Matching is not case sensitive.
 * @returns {boolean} true if valid request.
 */
function isValidURLRequest (uri) {
    var isMatch = false,
        uriCheckFor = uri.toLowerCase(),
        i;

    if (configuration.mustMatch) {
        for (i = 0; i < configuration.listenURI.length; i ++) {
            if (uriCheckFor == configuration.listenURI[i].toLowerCase()) {
                isMatch = true;
                break;
            }
        }
    }
    return isMatch;
}

/**
 * Given an ArcGIS Online URL scheme, convert it to a path that would enable us to retrieve a valid
 * token endpoint URL, allowing us to ask for a token. This function is Promise based, it will return
 * a promise that will either resolve with the URL (since it must do a network query to get it) or
 * an error if we could not figure it out.
 * @param url {string} a URL to transform.
 * @returns {Promise} The promise that will resolve with the new URL or an error.
 */
function getTokenEndpointFromURL(url) {
    var searchFor,
        index,
        tokenUrl,
        tokenUrlParts,
        method,
        parameters,
        tokenServiceUri = null;

    return new Promise(function(resolvePromise, rejectPromise) {
        // Convert request URL into a token endpoint URL. Look for '/rest/' in the requested URL (could be 'rest/services', 'rest/community'...)
        searchFor = '/rest/';
        index = url.indexOf(searchFor);
        if (index >= 0) {
            tokenUrl = url.substr(0, index) + '/rest/info';
        } else {
            searchFor = '/sharing/';
            index = url.indexOf(searchFor);
            if (index >= 0) {
                tokenUrl = url.substr(0, index) + '/sharing/rest/info';
            } else {
                tokenUrl = url + '/arcgis/rest/info';
            }
        }
        parameters = {
            f: 'json'
        };
        method = 'GET';
        tokenUrlParts = UrlFlexParser.parseAndFixURLParts(tokenUrl);
        if (tokenUrlParts != null && tokenUrlParts.hostname != null && tokenUrlParts.pathname != null && tokenUrlParts.protocol != null) {
            httpRequestPromiseResponse(tokenUrlParts.hostname, tokenUrlParts.pathname, method, tokenUrlParts.protocol == 'https', parameters).then(
                function (serverResponse) {
                    var authInfo = JSON.parse(serverResponse);
                    if (authInfo != null && authInfo.authInfo !== undefined) {
                        tokenServiceUri = authInfo.authInfo.tokenServicesUrl;
                    }
                    if (tokenServiceUri == null) {
                        // If no tokenServicesUrl, try to find owningSystemUrl as token endpoint
                        if (authInfo.owningSystemUrl !== undefined) {
                            tokenServiceUri = authInfo.owningSystemUrl + '/sharing/generateToken';
                        }
                    }
                    if (tokenServiceUri != null) {
                        resolvePromise(tokenServiceUri);
                    } else {
                        rejectPromise(new Error('Unable to transform ' + url + ' or ' + tokenUrl + ' into a token endpoint URL.'));
                    }
                },
                function (serverError) {
                    rejectPromise(serverError);
                }
            );
        } else {
            rejectPromise(new Error('Unable to transform ' + url + ' or ' + tokenUrl + ' into a usable URL.'));
        }
    });
}

/**
 * If the server URL configuration is such that a username/password is used to get a token then
 * this function will attempt to contact the service with the user credentials and get a valid token
 * on behalf of that user. This function is very asynchronous it may make several network requests
 * before it gets the token.
 * @param referrer {string} who we want the service to think is making the request.
 * @param serverUrlInfo {object} our configuration object for this service.
 * @returns {Promise} A promise to resolve with the new token or reject with an error.
 */
function getNewTokenFromUserNamePasswordLogin(referrer, serverUrlInfo) {
        var parameters,
            method = 'POST',
            tokenServiceUriParts,
            token;

    return new Promise(function(resolvePromise, rejectPromise) {
        if (ProjectUtilities.isPropertySet(serverUrlInfo, 'username') && ProjectUtilities.isPropertySet(serverUrlInfo, 'password')) {
            parameters = {
                request: 'getToken',
                f: 'json',
                referer: referrer,
                expiration: 60,
                username: serverUrlInfo.username,
                password: serverUrlInfo.password
            };
            getTokenEndpointFromURL(serverUrlInfo.url).then(
                function (tokenServiceUri) {
                    tokenServiceUriParts = UrlFlexParser.parseAndFixURLParts(tokenServiceUri);
                    httpRequestPromiseResponse(tokenServiceUriParts.host, tokenServiceUriParts.path, method, tokenServiceUriParts.protocol == 'https', parameters).then(
                        function (responseBody) {
                            token = ProjectUtilities.findTokenInString(responseBody, 'token');
                            resolvePromise(token);
                        },
                        function (error) {
                            rejectPromise(error);
                        }
                    );
                },
                function (error) {
                    rejectPromise(error);
                }
            );
        } else {
            rejectPromise(new Error('Both username and password must be set to enable user login.'));
        }
    });
}

/**
 * OAuth 2.0 mode authentication "App Login" - authenticating using oauth2Endpoint, clientId, and clientSecret specified
 * in configuration. Because this is an http request (or several) it is Promise based. The token is passed to the
 * promise resolve function or an error is passed to the promise reject function.
 * @param serverURLInfo
 * @param requestUrl
 * @return {Promise}
 */
function performAppLogin(serverURLInfo) {
    QuickLogger.logInfoEvent("Service is secured by " + serverURLInfo.oauth2Endpoint + ": getting new token...");
    var tokenRequestPromise = new Promise(function(resolvePromise, rejectPromise) {
        var oauth2Endpoint = serverURLInfo.oauth2Endpoint + 'token',
            parameters = {
                client_id: serverURLInfo.clientId,
                client_secret: serverURLInfo.clientSecret,
                grant_type: 'client_credentials',
                f: 'json'
            },
            oauthUrlParts = UrlFlexParser.parseAndFixURLParts(oauth2Endpoint),
            tokenResponse;

        httpRequestPromiseResponse(oauthUrlParts.hostname, oauthUrlParts.pathname, 'POST', oauthUrlParts.protocol == 'https', parameters).then(
            function(serverResponse) {
                tokenResponse = ProjectUtilities.findTokenInString(serverResponse, 'token');
                if (tokenResponse.length > 0) {
                    exchangePortalTokenForServerToken(tokenResponse, serverURLInfo).then(resolvePromise, rejectPromise);
                } else {
                    rejectPromise(new Error('App login could not get a token from the server response of ' + serverResponse));
                }
            },
            function(error) {
                rejectPromise(error);
            }
        );
    });
    return tokenRequestPromise;
}

function performUserLogin(serverURLInfo, requestUrl) {
    // standalone ArcGIS Server/ArcGIS Online token-based authentication
    var requestUrlParts = UrlFlexParser.parseAndFixURLParts(requestUrl),
        tokenResponse;

    QuickLogger.logInfoEvent("Service requires user login.");
    var tokenRequestPromise = new Promise(function(resolvePromise, rejectPromise) {
        // if a request is already being made to generate a token, just let it go. TODO: Where is username/password???
        if (requestUrlParts.pathname.toLowerCase().indexOf('/generatetoken') >= 0) {
            httpRequestPromiseResponse(requestUrlParts.hostname, requestUrlParts.pathname, 'POST', requestUrlParts.protocol == 'https', null).then(
                function(serverResponse) {
                    tokenResponse = ProjectUtilities.findTokenInString(serverResponse, 'token');
                    if (tokenResponse.length > 0) {
                        resolvePromise(tokenResponse);
                    } else {
                        rejectPromise(new Error('User login could not get a token from the server response of ' + serverResponse));
                    }
                },
                function(error) {
                    rejectPromise(error);
                }
            );
        } else {
            getNewTokenFromUserNamePasswordLogin(referrer, serverURLInfo).then(resolvePromise, rejectPromise);
        }
    });
    return tokenRequestPromise;
}

function getNewTokenIfCredentialsAreSpecified(serverURLInfo, requestUrl) {
    return new Promise(function(resolvePromise, rejectPromise) {
        if (serverURLInfo.isAppLogin) {
            performAppLogin(serverURLInfo).then(resolvePromise, rejectPromise);
        } else if (serverURLInfo.isUserLogin) {
            performUserLogin(serverURLInfo, requestUrl).then(resolvePromise, rejectPromise);
        }
    });
}

/**
 * Use the token we have and exchange it for a long-lived server token.
 * @param portalToken {string} user's short-lived token.
 * @param serverURLInfo {object} the server URL we are conversing with.
 * @returns {Promise} The promise to return the token from the server, once it arrives.
 */
function exchangePortalTokenForServerToken(portalToken, serverURLInfo) {
    var responsePromise = new Promise(function(resolvePromise, rejectPromise) {
        var parameters = {
                token: portalToken,
                serverURL: serverURLInfo.url,
                f: 'json'
            },
            uri = serverURLInfo.oauth2Endpoint.replace('/oauth2', '/generateToken'),
            oauthUrlParts = UrlFlexParser.parseAndFixURLParts(uri),
            host = oauthUrlParts.hostname,
            path = oauthUrlParts.path,
            tokenResponse;

        httpRequestPromiseResponse(host, path, 'POST', UrlFlexParser.getBestMatchProtocol('*', oauthUrlParts, serverURLInfo) == 'https', parameters).then(
            function(serverResponse) {
                tokenResponse = ProjectUtilities.findTokenInString(serverResponse, 'token');
                if (tokenResponse.length > 0) {
                    resolvePromise(tokenResponse);
                } else {
                    rejectPromise(new Error('Error could not get a token from the server response of ' + serverResponse));
                }
            },
            function(error) {
                rejectPromise(error);
            }
        );
    });
    return responsePromise;
}

/**
 * Issue an HTTP request and wait for a response from the server. An http request is an asynchronous request
 * using Node's http client. This is promised based, so the function returns a promise that will resolve with
 * the server response or fail with an error.
 * @param host {string} host server to contact www.sever.tld
 * @param path {string} path at server to request. Should begin with /.
 * @param method {string} GET|POST
 * @param useHttps {boolean} false uses http (80), true uses https (443)
 * @param parameters {object} request parameters object of key/values. Gets converted into a query string or post body depending on method.
 * @return {Promise} You get a promise that will resolve with the server response or fail with an error.
 */
function httpRequestPromiseResponse(host, path, method, useHttps, parameters) {
    var responsePromise = new Promise(function(resolvePromise, rejectPromise) {
        var httpRequestOptions = {
                hostname: host,
                path: path,
                method: method
            },
            requestBody = ProjectUtilities.objectToQueryString(parameters),
            requestHeaders = {},
            responseStatus = 0,
            responseBody = '',
            request;

        var handleServerResponse = function(response) {
            responseStatus = response.statusCode;
            if (responseStatus > 399) {
                rejectPromise(new Error('Error ' + responseStatus + ' on ' + host + path));
            } else {
                response.on('data', function (chunk) {
                    responseBody += chunk;
                });
                response.on('end', function () {
                    // if response looks like "{"error":{"code":498,"message":"Invalid token.","details":[]}}" then ERROR
                    if (ProjectUtilities.startsWith(responseBody, '{"error":')) {
                        responseStatus = ProjectUtilities.findNumberAfterTokenInString(responseBody, 'code');
                        rejectPromise(new Error('Error ' + responseStatus + ' on ' + host + path));
                    } else {
                        resolvePromise(responseBody);
                    }
                });
            }
        };

        if (method == 'POST') {
            requestHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
            requestHeaders['Content-Length'] = Buffer.byteLength(requestBody);
        } else if (method == 'GET' && requestBody.length > 0) {
            httpRequestOptions.path += '?' + requestBody;
            requestBody = '';
        }
        httpRequestOptions.headers = requestHeaders;
        if (useHttps) {
            httpRequestOptions.protocol = 'https:';
            request = https.request(httpRequestOptions, handleServerResponse);
        } else {
            httpRequestOptions.protocol = 'http:';
            request = http.request(httpRequestOptions, handleServerResponse);
        }
        request.on('error', function(error) {
            rejectPromise(error);
        });
        request.end(requestBody);
    });
    return responsePromise;
}

/**
 * Calling this function means the request has passed all tests and we are going to contact the proxied service
 * and try to reply back to the caller with what it responds with. We will do any token refresh here if necessary.
 * @param urlRequestedParts - our object of the request components.
 * @param serverURLInfo - the matching server url configuration for this request.
 * @param referrer {string} the validated referrer we are tracking (can be "*").
 * @param request - the http server request object.
 * @param response - the http server response object.
 * @return {boolean} true if the request was processed, false if we got an error.
 */
function processValidatedRequest (urlRequestedParts, serverURLInfo, referrer, request, response) {
    var statusCode = 200,
        statusMessage,
        proxyRequest,
        parsedHostRedirect,
        parsedProxy,
        hostname,
        contentType,
        parameters;

    if (serverURLInfo != null) {
        // TODO: GET - combine params from query with url request
        // TODO: POST - combine params from query with url request
        // TODO: test FILES
        // TODO: Handle Auth, oauth

        if (proxyServer != null) {
            serverURLInfo.lastRequest = new Date();
            if (serverURLInfo.firstRequest == 0) {
                serverURLInfo.firstRequest = serverURLInfo.lastRequest;
            }
            serverURLInfo.totalRequests ++;
            if (serverURLInfo.isHostRedirect) {
                // Host Redirect means we want to replace the host used in the request with a different host, but keep
                // everything else received in the request (path, query).
                parsedHostRedirect = serverURLInfo.parsedHostRedirect;
                parsedProxy = UrlFlexParser.parseAndFixURLParts(urlRequestedParts.proxyPath);
                parsedProxy.hostname = parsedHostRedirect.hostname;
                parsedProxy.protocol = UrlFlexParser.getBestMatchProtocol(referrer, parsedProxy, parsedHostRedirect);
                parsedProxy.port = UrlFlexParser.getBestMatchPort(referrer, parsedProxy, parsedHostRedirect);
                proxyRequest = UrlFlexParser.buildFullURLFromParts(parsedProxy);
                hostname = parsedProxy.hostname;
            } else {
                hostname = serverURLInfo.hostname;
            }

            // TODO: Combine parameters of the two requests, current request parameters override configured parameters
            // TODO: !!!! Fuck! can't do this here, as we do not have the body yet.
            if (request.method == 'POST' || request.method == 'PUT') {
                contentType = request.headers['Content-Type'];
                if (contentType.indexOf('x-www-form-urlencoded') >= 0) {
                    // Its a post we have to read the entire body and extract the token form parameter if it's there.

                } else if (contentType.indexOf('multipart') >= 0) {
                    // this sucks. A post with files means we need to parse the whole thing, find the form, hold the file(s)
                    // in memory, find the form parameters, see if there is a token, then resend it all to the server.

                }
            }
            // Combine query parameters of the current request with the configuration. The current request has priority.
            // TODO: Test different combinations of parameters
            // request.query="?token=1234512345&f=json&status=1"
            // urlRequestedParts.query="?token=1234512345&f=json&status=1"
            // serverURLInfo.query="?token=1234512345&f=json&status=1"
            parameters = UrlFlexParser.combineParameters(request, urlRequestedParts, serverURLInfo);
            // if no token was provided in the request but one is in the configuration then use the configured token.
            if (ProjectUtilities.isPropertySet(serverURLInfo, 'accessToken')) {
                ProjectUtilities.addIfPropertyNotSet(parameters, 'token', serverURLInfo.accessToken);
            } else if (ProjectUtilities.isPropertySet(serverURLInfo, 'token')) {
                ProjectUtilities.addIfPropertyNotSet(parameters, 'token', serverURLInfo.token);
            }
            // TODO: Test if parameters is empty
            urlRequestedParts.query = ProjectUtilities.objectToQueryString(parameters);
            proxyRequest = UrlFlexParser.buildURLFromReferrerRequestAndInfo(referrer, urlRequestedParts, serverURLInfo);
            // Fix the request to transform it from our proxy server into a spoof of the matching request against the
            // proxied service
            request.url = proxyRequest;
            request.headers.host = hostname;



            // TODO: if a token based request we should check if the token we have is any good and if not generate a new token


            // TODO: Not really sure this worked if the proxy generates an error as we are not catching any error from the proxied service
            validProcessedRequests ++;
            QuickLogger.logInfoEvent("==> Issuing proxy request [" + request.method + "](" + request.url + ") for " + proxyRequest);
            proxyServer.web(request, response, {
                target: proxyRequest,
                ignorePath: true
            }, proxyResponseError);
        } else {
            statusCode = 500;
            statusMessage = "Internal error: proxy server is not operating.";
            sendErrorResponse(urlRequestedParts.proxyPath, response, statusCode, statusMessage);
        }
    } else {
        statusCode = 403;
        statusMessage = "Request from " + referrer + ", proxy has not been set up for " + urlRequestedParts.listenPath + ".";
        if (QuickLogger.ifLogLevelGreaterOrEqual('INFO')) {
            statusMessage += " Make sure there is a serverUrl in the configuration file that matches " + urlRequestedParts.listenPath;
        }
        sendErrorResponse(urlRequestedParts.proxyPath, response, statusCode, statusMessage);
    }
    return statusCode != 200;
}

/**
 * Respond to a ping request. A ping tells a client we are alive and gives out some status response.
 * @param referrer {string} - who asked for it.
 * @param response {object} - http response object.
 */
function sendPingResponse (referrer, response) {
    var statusCode = 200,
        responseBody = {
            "Proxy Version": proxyVersion,
            "Configuration File": "OK",
            "Log File": "OK",
            "referrer": referrer
        };
    sendJSONResponse(response, statusCode, responseBody);
    validProcessedRequests ++;
    QuickLogger.logInfoEvent("Ping request from " + referrer);
}

/**
 * Respond to a server status request.
 * @param referrer - who asked for it.
 * @param response - http response object.
 */
function sendStatusResponse (referrer, response) {
    try {
        var timeNow = new Date(),
            i,
            serverUrl,
            serverUrls = configuration.serverUrls,
            responseObject = {
                "Proxy Version": proxyVersion,
                "Configuration File": "OK",
                "Log File": QuickLogger.getLogFileSize(),
                "Up-time": ProjectUtilities.formatMillisecondsToHHMMSS(timeNow - serverStartTime),
                "Requests": attemptedRequests,
                "Requests processed": validProcessedRequests,
                "Requests rejected": errorProcessedRequests,
                "Referrers Allowed": configuration.allowedReferrers.map(function (allowedReferrer) {
                    return allowedReferrer.referrer;
                }).join(', '),
                "Referrer": referrer,
                "URL Stats": [],
                "Rate Meter": []
            };
        for (i = 0; i < serverUrls.length; i ++) {
            serverUrl = serverUrls[i];
            if ( ! serverUrl.useRateMeter) {
                responseObject['URL Stats'].push({
                    'url': serverUrl.url.substring(0, 100) + (serverUrl.url.length > 100 ? '...' : ''),
                    'total': serverUrl.totalRequests,
                    'firstRequest': serverUrl.firstRequest == 0 ? '-' : serverUrl.firstRequest.toLocaleString(),
                    'lastRequest': serverUrl.lastRequest == 0 ? '-' : serverUrl.lastRequest.toLocaleString()
                });
            }
        }
        if (rateMeter != null) {
            rateMeter.databaseDump().then(function (responseIsArrayOfTableRows) {
                responseObject['Rate Meter'] = responseIsArrayOfTableRows;
                reportHTMLStatusResponse(responseObject, response);
            }, function (databaseError) {
                responseObject.error = databaseError.toLocaleString();
                reportHTMLStatusResponse(responseObject, response);
            });
        }
    } catch (exception) {
        sendErrorResponse('status', response, 500, 'System error processing request: ' + exception.toLocaleString());
    }
    QuickLogger.logInfoEvent("Status request from " + referrer);
}

/**
 * Create an HTML dump of some valuable information regarding the current status of this proxy server.
 * @param responseObject {Object} we iterate this object as the information to report.
 * @param response {Object} the http response object to write to.
 */
function reportHTMLStatusResponse (responseObject, response) {
    var responseBody,
        key,
        value,
        row,
        rowKey,
        rowValue,
        tableRow,
        i,
        statusCode = 200;

    responseBody = '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8">\n<title>Resource Proxy Status</title>\n</head>\n<body>\n\n<h1>Resource Proxy Status</h1>';
    for (key in responseObject) {
        if (responseObject.hasOwnProperty(key)) {
            value = responseObject[key];
            if (value instanceof Array) { // Arrays get displayed as tables
                responseBody += '<p><strong>' + key + ':</strong></p><table>';
                for (i = 0; i < value.length; i ++) {
                    tableRow = '<tr>';
                    row = value[i];
                    for (rowKey in row) {
                        if (row.hasOwnProperty(rowKey)) {
                            if (i == 0) {
                                responseBody += '<th>' + rowKey + '</th>';
                            }
                            rowValue = row[rowKey];
                            tableRow += '<td>' + rowValue + '</td>';
                        }
                    }
                    responseBody += '</tr>' + tableRow;
                }
                if (value.length == 0) {
                    responseBody += '<tr><td>** empty **</td>';
                }
                responseBody += '</tr></table>'
            } else {
                responseBody += '<p><strong>' + key + ':</strong> ' + value + '</p>\n';
            }
        }
    }
    responseBody += '\n</body></html>\n';
    response.writeHead(statusCode, {
        'Content-Length': Buffer.byteLength(responseBody),
        'Content-Type': 'text/html'
    });
    response.write(responseBody);
    response.end();
}

/**
 * Perform necessary node http-server functions to send reply in JSON format.
 * @param response - node http-server response object.
 * @param statusCode - a valid http status code (e.g. 200, 404, etc)
 * @param responseObject - a javascript object that is converted to JSON and sent back as the body.
 */
function sendJSONResponse (response, statusCode, responseObject) {
    var responseBody = JSON.stringify(responseObject);
    response.writeHead(statusCode, {
        'Content-Length': Buffer.byteLength(responseBody),
        'Content-Type': 'application/json'
    });
    response.write(responseBody);
    response.end();
}

/**
 * Reply with an error JSON object describing what may have gone wrong. This is used if there is
 * an error calling this proxy service, not for errors with the proxied service.
 * @param urlRequested the path that was requested.
 * @param response the response object so we can complete the response.
 * @param errorCode the error code we want to report to the caller.
 * @param errorMessage the error message we want to report to the caller.
 */
function sendErrorResponse (urlRequested, response, errorCode, errorMessage) {
    var responseBody = {
        error: {
            code: errorCode,
            details: errorMessage,
            message: errorMessage
        },
        request: urlRequested
    };
    sendJSONResponse(response, errorCode, responseBody);
    errorProcessedRequests ++;
    QuickLogger.logErrorEvent("Request error: " + errorMessage + " (" + errorCode + ") for " + urlRequested);
}

/**
 * Determine if this request is within the rate meter threshold. If it is we continue to processValidatedRequest().
 * If it is not we generate the client reply here. Because the rate meter check is asynchronous and this function will
 * return before the check is complete it was just easier to deal with all subsequent processing here instead of
 * turning this into a promise. Something to reconsider for the next update.
 * @param referrer {string} the validated referrer we are tracking (can be "*").
 * @param requestParts - the parsed URL that is being requested
 * @param serverURLInfo - the serverUrls object matching this request
 * @param request - the http request object, needed to pass on to processValidatedRequest or error response
 * @param response - the http response object, needed to pass on to processValidatedRequest or error response
 * @return {int} status code, but since this function is asynchronous the code is mostly meaningless
 */
function checkRateMeterThenProcessValidatedRequest(referrer, requestParts, serverURLInfo, request, response) {
    var statusCode = 200;
    if (rateMeter != null) {
        rateMeter.isUnderRate(referrer, serverURLInfo).then(function (isUnderCap) {
            if (isUnderCap) {
                processValidatedRequest(requestParts, serverURLInfo, referrer, request, response);
            } else {
                statusCode = 429; // TODO: or is it 402? or 420?
                QuickLogger.logWarnEvent("RateMeter dissallowing access to " + serverURLInfo.url + " from " + referrer);
                sendErrorResponse(request.url, response, statusCode, 'This is a metered resource, number of requests have exceeded the rate limit interval.');
            }
        }, function (error) {
            statusCode = 420;
            QuickLogger.logErrorEvent("RateMeter failed on " + serverURLInfo.url + " from " + referrer + ": " + error.toString());
            sendErrorResponse(request.url, response, statusCode, 'This is a metered resource but the server failed to determine the meter status of this resource.');
        });
    } else {
        statusCode = 500;
    }
    return statusCode;
}

/**
 * When the server receives a request we come here with the node http/https request object and
 * we fill in the response object.
 * @param request
 * @param response
 */
function processRequest(request, response) {
    var requestParts = UrlFlexParser.parseURLRequest(request.url, configuration.listenURI),
        serverURLInfo,
        referrer;

    attemptedRequests ++;
    if (requestParts != null) {
        referrer = request.headers['referer'];
        if (referrer == null || referrer.length < 1) {
            referrer = '*';
        } else {
            referrer = referrer.toLowerCase().trim();
        }
        QuickLogger.logInfoEvent('---- New request from ' + referrer + ' for ' + requestParts.listenPath + ' ----');
        if (requestParts.listenPath == configuration.localPingURL) {
            sendPingResponse(referrer, response);
        } else {
            referrer = UrlFlexParser.validatedReferrerFromReferrer(referrer, configuration.allowedReferrers);
            if (referrer != null) {
                if (requestParts.listenPath == configuration.localStatusURL) {
                    sendStatusResponse(referrer, response);
                } else {
                    if (isValidURLRequest(requestParts.listenPath)) {
                        serverURLInfo = getServerUrlInfo(requestParts);
                        if (serverURLInfo != null) {
                            request.serverUrlInfo = serverURLInfo;
                            if (serverURLInfo.useRateMeter) {
                                checkRateMeterThenProcessValidatedRequest(referrer, requestParts, serverURLInfo, request, response);
                            } else {
                                processValidatedRequest(requestParts, serverURLInfo, referrer, request, response);
                            }
                        } else if (! configuration.mustMatch) {
                            // TODO: I think we should remove this feature
                            // when mustMatch is false we accept absolutely anything (why, again, are we doing this?) so blindly forward the request on and cross your fingers someone actually thinks this is a good idea.
                            serverURLInfo = UrlFlexParser.parseAndFixURLParts(requestParts.listenPath);
                            serverURLInfo = {
                                url: serverURLInfo.hostname + serverURLInfo.path,
                                protocol: requestParts.protocol,
                                hostname: serverURLInfo.hostname,
                                path: serverURLInfo.path,
                                port: serverURLInfo.port,
                                rate: 0,
                                rateLimitPeriod: 0
                            };
                            processValidatedRequest(requestParts, serverURLInfo, referrer, request, response);
                        } else {
                            sendErrorResponse(request.url, response, 404, 'Resource ' + request.url + ' not found.');
                        }
                    } else {
                        // try to serve a static resource. proxyServeFile will always send its own response.
                        proxyServeFile(request, response);
                    }
                }
            } else {
                sendErrorResponse(request.url, response, 403, 'referrer ' + referrer + ' not allowed.');
            }
        }
    } else {
        sendErrorResponse(request.url, response, 403, 'Invalid request: could not parse request as a valid request.');
    }
}

/**
 * If the proxy target responds with an error we catch it here.
 * @param error
 */
function proxyResponseError(error, proxyRequest, proxyResponse, proxyTarget) {
    if (proxyResponse.status === undefined) {
        proxyResponse.status = 502;
    }
    QuickLogger.logErrorEvent('proxyResponseError caught error ' + error.code + ': ' + error.description + ' on ' + proxyTarget + ' status=' + proxyResponse.status);
    sendErrorResponse(proxyRequest.url, proxyResponse, proxyResponse.status, 'Proxy request error: ' + error.code + ': ' + error.description);
}

/**
 * If the proxy target responds with an error we catch it here. I believe this is only for socket errors
 * as I have yet to catch any errors here.
 * @param proxyError
 */
function proxyErrorHandler(proxyError, proxyRequest, proxyResponse) {
    sendErrorResponse(proxyRequest.url, proxyResponse, 500, 'Proxy error ' + proxyError.toString());
}

/**
 * The proxy service gives us a chance to alter the request before forwarding it to the proxied server.
 * @param proxyReq
 * @param proxyRequest
 * @param proxyResponse
 * @param options
 */
function proxyRequestRewrite(proxyReq, proxyRequest, proxyResponse, options) {
    QuickLogger.logInfoEvent("proxyRequestRewrite opportunity to alter request before contacting service.");
}

/**
 * The proxy service gives us a chance to alter the response before sending it back to the client. We are using
 * this to check for failed authentication replies. If the service is using tokens we can attempt to resolve
 * the expired or missing token.
 * @param serviceResponse - response from the service
 * @param proxyRequest - original request object
 * @param proxyResponse - response object from the proxy
 * @param options
 */
function proxyResponseRewrite(serviceResponse, proxyRequest, proxyResponse) {
    var serverUrlInfo = proxyRequest.serverUrlInfo || {mayRequireToken: false};
    QuickLogger.logInfoEvent("proxyResponseRewrite opportunity to alter response before writing it.");
    if (serviceResponse.headers['content-type'] !== undefined) {
        var lookFor = 'application/vnd.ogc.wms_xml';
        var replaceWith = 'text/xml';
        serviceResponse.headers['content-type'] = serviceResponse.headers['content-type'].replace(lookFor, replaceWith);
    }
    if (serverUrlInfo.mayRequireToken) {
        // TODO: See if we got error 498/499. if so we need to generate a token. To do this we need to review the server reply and see if it failed because of a bad/missing token
        checkServerResponseForMissingToken(proxyResponse, serviceResponse.headers['content-encoding'], function (body) {
            var errorCode,
                newTokenIsRequired = false;

            if (body) {
                var errorCode = body.error.code;
                if (errorCode == 403 || errorCode == 498 || errorCode == 499) {
                    newTokenIsRequired = true;
                }
            }
            return newTokenIsRequired;
        });
    }
}

/**
 * Event we receive once the serviced request has completed.
 * @param proxyRequest
 * @param proxyResponse
 * @param serviceResponse
 */
function proxyResponseComplete(proxyRequest, proxyResponse, serviceResponse) {
    if (proxyResponse) {
        var buffer = serviceResponse.body;
        if (buffer != null && buffer.length > 0) {
            QuickLogger.logInfoEvent("proxyResponseComplete got something is reply from service.");
        }
    }
}

/**
 * Handle a request for specific files we can serve from the proxy server. Files are served from the assets folder.
 * Note this function always sends a response back to the requesting client.
 * @param request {object} the request being made.
 * @param response {object} the proxy server's response object.
 */
function proxyServeFile(request, response) {
    var responseStatus = 200,
        responseMessage;

    if (request.method == 'GET') {
        var requestedUrl = urlParser.parse(request.url, true),
            action = requestedUrl.pathname;

        if (action == '/') {
            responseStatus = 404;
            responseMessage = 'Resource not found.';
        } else {
            // serve our static assets from the local ../assets folder. TODO: consider making this a configuration setting.
            var filePath = path.join(path.dirname(__dirname), 'assets', action).split('%20').join(' '),
                fileDomain = require('domain').create();

            // from this point we are running asynchronous so inside this function we must fully handle responses
            fileDomain.on('error', function(fileError) {
                responseStatus = 403;
                sendErrorResponse(request.url, response, responseStatus, 'Resource not accessible.');
            });
            fileDomain.run(function() {
                fs.stat(filePath, function (fileError, fileStat) {
                    if (fileError == null && fileStat != null) {
                        // set the content type and length
                        var fileType = path.extname(action),
                            contentType = '',
                            contentLength = fileStat.size;

                        switch (fileType) {
                            case '.gif':
                                contentType = 'image/gif';
                                break;
                            case '.jpg':
                            case '.jpeg':
                                contentType = 'image/jpeg';
                                break;
                            case '.png':
                                contentType = 'image/png';
                                break;
                            case '.ico':
                                contentType = 'image/vnd.microsoft.icon';
                                break;
                            case '.txt':
                                contentType = 'text/plain';
                                break;
                            default:
                                responseStatus = 404;
                                break;
                        }
                        if (contentType != '') {
                            responseStatus = 200;
                            response.writeHead(responseStatus, {'Content-Type': contentType, 'Content-Length': contentLength});
                            fs.createReadStream(filePath).pipe(response);
                        }
                    } else {
                        responseStatus = 404;
                        sendErrorResponse(request.url, response, responseStatus, 'Resource not found.');
                    }
                });
            });
        }
    } else {
        responseStatus = 405;
        responseMessage = 'Method not supported.';
    }
    if (responseStatus != 200) {
        sendErrorResponse(request.url, response, responseStatus, responseMessage);
    }
}

function checkServerResponseForMissingToken(proxyResponse, contentType, functionThatChecksForMissingToken) {
    var buffer = new BufferHelper(),
        tokenIsMissing = false,
        reponseWrite = proxyResponse.write,
        responseEnd = proxyResponse.end;

    // TODO: Content type can be deflate and gzip we need to handle both of those.

    // Rewrite response method and get the content body.
    proxyResponse.write = function (data) {
        buffer.concat(data);
    };

    proxyResponse.end = function () {
        // TODO: I really don't like this. We are going to parse the entire response to see if we receive the specific error we
        // are looking for. if it is an error this is pretty small, but if its not an error we could be parsing a rather monstrous amount of json! only to convert it back to string!
        // Maybe better to regex match '{"error":{"code":500' => '\"error\":[\s]*{[\s]*\"code\":[\s]*[\d]*'
        var body;
        try {
            body = JSON.parse(buffer.toBuffer().toString());
            if (body == null) {
                body = buffer.toBuffer().toString();
            } else {
                tokenIsMissing = functionThatChecksForMissingToken(body);
                // Converts the JSON back to buffer.
                body = new BufferHelper(JSON.stringify(body));
            }
        } catch (e) {
            console.log('JSON.parse error:', e);
            body = buffer.toBuffer().toString();
        }
        if ( ! tokenIsMissing) {
            // Call the response method
            reponseWrite.call(proxyResponse, body);
            responseEnd.call(proxyResponse);
        } else {
            // TODO: discard this response. get a new token from the token generator. retry the request with the new token. Send back the new response instead.
            reponseWrite.call(proxyResponse, 'We could not generate a new token for you.');
            responseEnd.call(proxyResponse);
        }
    };
}

/**
 * Run the server. This function never returns. You have to kill the process, such as ^C or kill.
 * All connection requests are forwarded to processRequest(q, r).
 */
function startServer () {
    var httpsOptions,
        hostName,
        proxyServerOptions = {};

    try {
        UrlFlexParser.setConfiguration(configuration);
        serverStartTime = new Date();
        hostName = OS.hostname() + ' (' + OS.type() + ', ' + OS.release() + ')';
        QuickLogger.logInfoEvent("Starting proxy version " + proxyVersion + " running on " + hostName + " via " + (configuration.useHTTPS ? 'HTTPS' : 'HTTP') + " server on port " + configuration.port + " -- " + serverStartTime.toLocaleString());

        // The RateMeter depends on the configuration.serverUrls being valid.
        rateMeter = RateMeter(configuration.serverUrls, configuration.allowedReferrers, QuickLogger.logErrorEvent.bind(QuickLogger));
        rateMeter.start();

        // If we are to run an https server we need to load the certificate and the key
        if (configuration.useHTTPS) {
            if (configuration.httpsPfxFile !== undefined) {
                httpsOptions = {
                    pfx: fs.readFileSync(configuration.httpsPfxFile)
                };
            } else if (configuration.httpsKeyFile !== undefined && configuration.httpsCertificateFile !== undefined) {
                httpsOptions = {
                    key: fs.readFileSync(configuration.httpsKeyFile),
                    cert: fs.readFileSync(configuration.httpsCertificateFile)
                };
            } else {
                QuickLogger.logErrorEvent("HTTPS proxy was requested but the necessary files [httpsPfxFile or httpsKeyFile, httpsCertificateFile] were not defined in configuration.");
            }
            httpServer = https.createServer(httpsOptions, processRequest);
        } else {
            httpServer = http.createServer(processRequest);
        }
        if (httpServer != null) {
            httpServer.on('clientError', function (error, socket) {
                errorProcessedRequests ++;
                socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
            });
            proxyServer = new httpProxy.createProxyServer(proxyServerOptions);
            proxyServer.on('error', proxyErrorHandler);
            proxyServer.on('proxyReq', proxyRequestRewrite);
            proxyServer.on('proxyRes', proxyResponseRewrite);
            proxyServer.on('end', proxyResponseComplete);

            // Integration tests require a fully parsed configuration and a started server, so they were delayed until this point.
            if (waitingToRunIntegrationTests) {
                __runIntegrationTests();
            }

            // Begin listening for client connections
            httpServer.listen(configuration.port);
        } else {
            QuickLogger.logErrorEvent("Proxy server was not created, probably a OS system or memory issue.");
        }
    } catch (exception) {
        QuickLogger.logErrorEvent("Proxy server encountered an exception and is not able to start: " + exception.toLocaleString());
    }
}

/**
 * When loading the configuration fails we end up here with a reason message. We terminate the app.
 * @param reason {Error} A message indicating why the configuration failed.
 */
function cannotStartServer(reason) {
    QuickLogger.logErrorEvent("!!! Server not started due to invalid configuration. " + reason.message);
    process.exit();
}

/**
 * Perform any actions when the app is terminated.
 * @param options
 * @param error
 */
function exitHandler (options, error) {
    QuickLogger.logEventImmediately(QuickLogger.LOGLEVEL.INFO.value, 'Stopping server via ' + options.reason);
    if (rateMeter != null) {
        rateMeter.stop();
        rateMeter = null;
    }
    if (error) {
        console.log(error.stack);
    }
    if (options.exit) {
        if (proxyServer != null) {
            proxyServer.close();
        }
        process.exit();
    }
}

/**
 * Set up the node process exit handlers and any other node integration we require.
 * @param process
 */
function configProcessHandlers(process) {
    process.stdin.resume(); // so the program will not close instantly

    // Set handler for app shutdown event
    process.on('exit', exitHandler.bind(null, {reason: "normal exit"}));
    process.on('SIGINT', exitHandler.bind(null, {exit: true, reason: "app terminated via SIGINT"}));
    process.on('uncaughtException', exitHandler.bind(null, {exit: true, reason: "uncaught exception"}));
}

/**
 * Run any tests that require our server is up and running. Waits for the server to be up and running
 * before scheduling the tests. These tests are here because the functions were not exported and not
 * accessible to the unit/integration test object.
 */
function runIntegrationTests() {
    if (configurationComplete) {
        __runIntegrationTests();
    } else {
        waitingToRunIntegrationTests = true;
    }
}

function __runIntegrationTests() {
    var testStr;
    var targetStr;
    var result;

    waitingToRunIntegrationTests = false;

    console.log("TTTTT Starting ProxyJS integration tests ");

    QuickLogger.logInfoEvent('This is an Info level event');
    QuickLogger.logWarnEvent('This is a Warning level event');
    QuickLogger.logErrorEvent('This is an Error level event');

    testStr = '/proxy/geo.arcgis.com/ArcGIS/rest/info/';
    result = UrlFlexParser.parseURLRequest(testStr, configuration.listenURI);
    console.log('parseURLRequest url=' + testStr + ' result=' + JSON.stringify(result));

    testStr = '/proxy/http/geo.arcgis.com/ArcGIS/rest/info/';
    result = UrlFlexParser.parseURLRequest(testStr, configuration.listenURI);
    console.log('parseURLRequest url=' + testStr + ' result=' + JSON.stringify(result));

    testStr = '/proxy/https/geo.arcgis.com/ArcGIS/rest/info/';
    result = UrlFlexParser.parseURLRequest(testStr, configuration.listenURI);
    console.log('parseURLRequest url=' + testStr + ' result=' + JSON.stringify(result));

    testStr = '/proxy/*/geo.arcgis.com/ArcGIS/rest/info/';
    result = UrlFlexParser.parseURLRequest(testStr, configuration.listenURI);
    console.log('parseURLRequest url=' + testStr + ' result=' + JSON.stringify(result));

    testStr = '/proxy?geo.arcgis.com/ArcGIS/rest/info/';
    result = UrlFlexParser.parseURLRequest(testStr, configuration.listenURI);
    console.log('parseURLRequest url=' + testStr + ' result=' + JSON.stringify(result));

    testStr = '/proxy?http/geo.arcgis.com/ArcGIS/rest/info/';
    result = UrlFlexParser.parseURLRequest(testStr, configuration.listenURI);
    console.log('parseURLRequest url=' + testStr + ' result=' + JSON.stringify(result));

    testStr = '/proxy?http://geo.arcgis.com/ArcGIS/rest/info/';
    result = UrlFlexParser.parseURLRequest(testStr, configuration.listenURI);
    console.log('parseURLRequest url=' + testStr + ' result=' + JSON.stringify(result));

    testStr = '/proxy&geo.arcgis.com/ArcGIS/rest/info/';
    result = UrlFlexParser.parseURLRequest(testStr, configuration.listenURI);
    console.log('parseURLRequest url=' + testStr + ' result=' + JSON.stringify(result));

    testStr = '/proxy&http/geo.arcgis.com/ArcGIS/rest/info/';
    result = UrlFlexParser.parseURLRequest(testStr, configuration.listenURI);
    console.log('parseURLRequest url=' + testStr + ' result=' + JSON.stringify(result));

    testStr = '/proxy&http://geo.arcgis.com/ArcGIS/rest/info/';
    result = UrlFlexParser.parseURLRequest(testStr, configuration.listenURI);
    console.log('parseURLRequest url=' + testStr + ' result=' + JSON.stringify(result));

    testStr = '';
    result = UrlFlexParser.parseURLRequest(testStr, configuration.listenURI);
    console.log('parseURLRequest url=' + testStr + ' result=' + JSON.stringify(result));


    testStr = "server.gateway.com"; // should match *.gateway.com
    targetStr = UrlFlexParser.validatedReferrerFromReferrer(testStr, configuration.allowedReferrers);
    console.log('validatedReferrerFromReferrer referrer=' + testStr + ' result=' + targetStr);

    testStr = "www.gateway.com"; // should match *.gateway.com
    targetStr = UrlFlexParser.validatedReferrerFromReferrer(testStr, configuration.allowedReferrers);
    console.log('validatedReferrerFromReferrer referrer=' + testStr + ' result=' + targetStr);

    testStr = "https://www.customer.com/gateway"; // should match www.customer.com
    targetStr = UrlFlexParser.validatedReferrerFromReferrer(testStr, configuration.allowedReferrers);
    console.log('validatedReferrerFromReferrer referrer=' + testStr + ' result=' + targetStr);

    testStr = "https://www.brindle.com/gateway"; // should match *://*/gateway
    targetStr = UrlFlexParser.validatedReferrerFromReferrer(testStr, configuration.allowedReferrers);
    console.log('validatedReferrerFromReferrer referrer=' + testStr + ' result=' + targetStr);

    testStr = "https://www.esri.com/1/2/3"; // should match https://*
    targetStr = UrlFlexParser.validatedReferrerFromReferrer(testStr, configuration.allowedReferrers);
    console.log('validatedReferrerFromReferrer referrer=' + testStr + ' result=' + targetStr);

    testStr = "http://www.esri.com/1/2/3"; // should NOT match https://*
    targetStr = UrlFlexParser.validatedReferrerFromReferrer(testStr, configuration.allowedReferrers);
    console.log('validatedReferrerFromReferrer referrer=' + testStr + ' result=' + targetStr);

    testStr = "*"; // should not match anything
    targetStr = UrlFlexParser.validatedReferrerFromReferrer(testStr, configuration.allowedReferrers);
    console.log('validatedReferrerFromReferrer referrer=' + testStr + ' result=' + targetStr);


    httpRequestPromiseResponse("www.enginesis.com", "/index.php", "POST", false, {fn: "ESRBTypeList", site_id: 100, response: "json", user_id: 9999}).then(function(responseBody) {
        result = responseBody;
        console.log('httpRequestPromiseResponse POST ' + result);
    }, function(error) {
        console.log('httpRequestPromiseResponse POST error ' + error.message);
    });

    httpRequestPromiseResponse("www.enginesis.com", "/index.php", "GET", false, {fn: "ESRBTypeList", site_id: 100, response: "json", user_id: 9999}).then(function(responseBody) {
        result = responseBody;
        console.log('httpRequestPromiseResponse GET ' + result);
    }, function(error) {
        console.log('httpRequestPromiseResponse GET error ' + error.message);
    });


    var serverUrlInfo;
    var urlParts;
    testStr = '/proxy/http://route.arcgis.com/arcgis/rest/services/World/ClosestFacility/NAServer/ClosestFacility_World/solveClosestFacility';
    urlParts = UrlFlexParser.parseURLRequest(testStr, configuration.listenURI);
    serverUrlInfo = getServerUrlInfo(urlParts);
    getTokenEndpointFromURL(serverUrlInfo.url).then(
        function(endpoint) {
            console.log('getTokenEndpointFromURL got ' + endpoint);
        },
        function(error) {
            console.log('getTokenEndpointFromURL fails with ' + error.message);
        }
    );

    testStr = 'http://developers.arcgis.com';
    getNewTokenFromUserNamePasswordLogin(testStr, serverUrlInfo).then(
        function(token) {
            console.log('getNewTokenFromUserNamePasswordLogin got ' + token);
        },
        function(error) {
            console.log('getNewTokenFromUserNamePasswordLogin fails with ' + error.message);
        }
    );

    // exchangePortalTokenForServerToken(portalToken, serverURLInfo);

    // getNewTokenIfCredentialsAreSpecified(serverURLInfo, requestUrl);


    console.log("TTTTT Completed ProxyJS integration tests ");
}

function loadConfigThenStart() {
    configProcessHandlers(process);
    Configuration.loadConfigurationFile().then(startServer, cannotStartServer);
}

exports.ArcGISProxyIntegrationTest = runIntegrationTests;

loadConfigThenStart();
