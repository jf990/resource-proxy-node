/**
 * A URL parser that also handles the weird rules we employ in our proxy service.
 * Accepted URL formats:
 *    http://service.host.tld/proxy?http://services.arcgisonline.com/ArcGIS/rest/services/?f=pjson
 *    http://service.host.tld/sproxy?http://services.arcgisonline.com/ArcGIS/rest/services/?f=pjson
 *    http://service.host.tld/proxy/http/services.arcgisonline.com/ArcGIS/rest/services/?f=pjson
 *    http://service.host.tld/proxy/http://services.arcgisonline.com/ArcGIS/rest/services/?f=pjson
 *    http://service.host.tld/path/path?query=string&key=value
 *    https://service.host.tld/path/path?query=string&key=value
 *    *://service.host.tld/path/path?query=string&key=value
 *    //service.host.tld/path/path?query=string&key=value
 *    //*.host.tld/path/path?query=string&key=value
 *    *.host.tld/path/path?query=string&key=value
 *    *.host.tld/*?query=string&key=value
 *
 *    Any piece is optional and defaults are used if a part is not identified.
 *
 * The part after the proxy path is taken as the service to proxy to. It is looked up in the serviceURLs table
 * and if matched the service information of that entry is used to make the request with the service. What the
 * service responds with is then passed back to the caller.
 *
 * TODO: This would be better if it were an object/class definition with properties and methods. The current
 * implementation is a result of code refactoring that later grew beyond its original design.
 */

const urlParser = require('url');
const ProjectUtilities = require('./ProjectUtilities');
const QuickLogger = require('./QuickLogger');

var allowAnyReferrer;
var matchAllReferrer;
var useHTTPS = true;


/**
 * Internal helper function to log a message at the assigned log level.
 * @param message {string}
 */
function logMessage(message) {
    if (message != null && message.length > 0) {
        QuickLogger.logInfoEvent(message);
    }
}

/**
 * Given a configuration object takes the values we can use and copy them to local variables.
 * @param configuration {object}
 */
module.exports.setConfiguration = function(configuration) {
    if (configuration.logLevel !== undefined) {
        logLevel = configuration.logLevel;
    } else {
        logLevel = 0;
    }
    if (configuration.logFunction !== undefined) {
        logFunction = configuration.logFunction;
    } else {
        logFunction = null;
    }
    if (configuration.useHTTPS !== undefined) {
        useHTTPS = configuration.useHTTPS;
    } else {
        useHTTPS = false;
    }
    if (configuration.matchAllReferrer !== undefined) {
        matchAllReferrer = configuration.matchAllReferrer;
    } else {
        matchAllReferrer = true;
    }
    if (configuration.allowAnyReferrer !== undefined) {
        allowAnyReferrer = configuration.allowAnyReferrer;
    } else {
        allowAnyReferrer = false;
    }
};

/**
 * Parse the URL and produce an object with all the parts of the URL. Returns an object in the form
 * {
 *   url: = the original URL
 *   protocol: = protocol extracted from URL or *
 *   hostname: = host extracted from URL or *
 *   port: = port number extracted from URL or *
 *   pathname: = path extracted from URL, starting with / and default will be /
 *   query: = query string extracted from URL without the ?, or ""
 * }
 * @param url {string}
 * @returns {object}
 */
module.exports.parseAndFixURLParts = function(url) {
    var urlParts = urlParser.parse(url),
        delimiter;

    if (urlParts != null) {
        if (urlParts.protocol == null || urlParts.protocol == '') {
            urlParts.protocol = '*';
        } else {
            delimiter = urlParts.protocol.indexOf(':');
            if (delimiter > 0) {
                urlParts.protocol = urlParts.protocol.substr(0, delimiter);
            }
        }
        if (urlParts.hostname == null || urlParts.hostname == '') {
            if (urlParts.pathname == null || urlParts.pathname == '') {
                urlParts.pathname = '*';
            }
            urlParts.hostname = urlParts.pathname;
            urlParts.pathname = '*';
            delimiter = urlParts.hostname.indexOf('//');
            if (delimiter >= 0) {
                urlParts.hostname = urlParts.hostname.substr(delimiter + 2);
            }
            while (urlParts.hostname.charAt(0) == '/') {
                urlParts.hostname = urlParts.hostname.substr(1);
            }
            delimiter = urlParts.hostname.indexOf('/');
            if (delimiter > 0) {
                urlParts.pathname = urlParts.hostname.substr(delimiter);
                urlParts.hostname = urlParts.hostname.substr(0, delimiter);
            }
        }
        if (urlParts.port == null || urlParts.port == '') {
            urlParts.port = '*';
        }
        if (urlParts.pathname == null || urlParts.pathname == '' || urlParts.pathname == '/*' || urlParts.pathname == '/') {
            urlParts.pathname = '*';
        }
        urlParts.path = urlParts.pathname;
        urlParts.host = urlParts.hostname;
    }
    return urlParts;
};

/**
 * Break apart the full URL request and determine its constituent parts. This is a bit non-standard due
 * to the special case handling of ? and &. Examples:
 *     /proxy/http/host.domain.tld/path/path?q=1&t=2
 *     /proxy?http://host.domain.tld/path/path?q=1&t=2
 *     /proxy&http://host.domain.tld/path/path?q=1&t=2
 * Returns: object:
 *   listenPath: the base URL pattern we are to be listening for
 *   proxyPath: the URI/URL pattern to proxy
 *   protocol: if part of the URI pattern we extract it
 *   query: part after a ? in the URL in case we need to pass that along
 * @param url {string} url we want to parse
 * @param listenUriList {Array} list of Uri's we are listening for. e.g. '/proxy'.
 * @returns {{listenPath: string, proxyPath: string, query: string, protocol: string}}
 */
module.exports.parseURLRequest = function(url, listenUriList) {
    var result = {
            listenPath: '',
            proxyPath: '',
            query: '',
            protocol: '*'
        },
        charDelimiter,
        lookFor,
        i,
        isMatch = false;

    url = decodeURI(url);
    if (url != null && url.length > 0) {
        // brute force take anything after http or https
        // TODO: regex pattern is '[\/|\?|&]http[s]?[:]?\/' we should consider that vs. the brute force method here.
        lookFor = '/https/';
        charDelimiter = url.indexOf(lookFor);
        if (charDelimiter >= 0) {
            isMatch = true;
            result.protocol = 'https';
            result.proxyPath = url.substr(charDelimiter + lookFor.length - 1);
            url = url.substr(0, charDelimiter);
        } else {
            lookFor = '?https://';
            charDelimiter = url.indexOf(lookFor);
            if (charDelimiter >= 0) {
                isMatch = true;
                result.protocol = 'https';
                result.proxyPath = url.substr(charDelimiter + lookFor.length - 1);
                url = url.substr(0, charDelimiter);
            } else {
                lookFor = '&https://';
                charDelimiter = url.indexOf(lookFor);
                if (charDelimiter >= 0) {
                    isMatch = true;
                    result.protocol = 'https';
                    result.proxyPath = url.substr(charDelimiter + lookFor.length - 1);
                    url = url.substr(0, charDelimiter);
                }
            }
        }
        if (! isMatch) {
            lookFor = '/http/';
            charDelimiter = url.indexOf(lookFor);
            if (charDelimiter >= 0) {
                isMatch = true;
                result.protocol = 'http';
                result.proxyPath = url.substr(charDelimiter + lookFor.length - 1);
                url = url.substr(0, charDelimiter);
            } else {
                lookFor = '?http://';
                charDelimiter = url.indexOf(lookFor);
                if (charDelimiter >= 0) {
                    isMatch = true;
                    result.protocol = 'http';
                    result.proxyPath = url.substr(charDelimiter + lookFor.length - 1);
                    url = url.substr(0, charDelimiter);
                } else {
                    lookFor = '&http://';
                    charDelimiter = url.indexOf(lookFor);
                    if (charDelimiter >= 0) {
                        isMatch = true;
                        result.protocol = 'http';
                        result.proxyPath = url.substr(charDelimiter + lookFor.length - 1);
                        url = url.substr(0, charDelimiter);
                    }
                }
            }
        }
        if (! isMatch) {
            // possible there was a wildcard protocol, now how do we figure that out?
            lookFor = '/*/';
            charDelimiter = url.indexOf(lookFor);
            if (charDelimiter >= 0) {
                result.protocol = '*';
                result.proxyPath = url.substr(charDelimiter + lookFor.length - 1);
                url = url.substr(0, charDelimiter);
            } else {
                // TODO: if just ? or & how do we know if a path or a query string?
                for (i = 0; i < listenUriList.length; i ++) {
                    lookFor = listenUriList[i];
                    if (lookFor.charAt(lookFor.length) != '/') {
                        lookFor += '/';
                    }
                    charDelimiter = url.indexOf(lookFor);
                    if (charDelimiter == 0) {
                        isMatch = true;
                        result.protocol = '*'; // TODO: can protocol be something other than http[?]://?
                        result.proxyPath = url.substr(charDelimiter + lookFor.length);
                        url = listenUriList[i];
                        break;
                    }
                }
            }
        }
        result.listenPath = url;
        lookFor = '?'; // take anything after a ? as the query string
        charDelimiter = result.proxyPath.indexOf(lookFor);
        if (charDelimiter >= 0) {
            result.query = result.proxyPath.substr(charDelimiter + 1);
            result.proxyPath = result.proxyPath.substr(0, charDelimiter);
        }
    }
    return result;
};

/**
 * Combine two components of a URL or file path to make sure they are separated by one and only one /.
 * @param firstPart
 * @param secondPart
 * @returns {string} firstPart + '/' + secondPart.
 */
module.exports.combinePath = function(firstPart, secondPart) {
    if (firstPart != null && firstPart.length > 0) {
        while (firstPart.charAt(firstPart.length - 1) == '/') {
            firstPart = firstPart.substr(0, firstPart.length - 1);
        }
    } else {
        firstPart = '';
    }
    if (secondPart != null && secondPart.length > 0) {
        while (secondPart.charAt(0) == '/') {
            secondPart = secondPart.substr(1);
        }
    } else {
        secondPart = '';
    }
    return firstPart + '/' + secondPart;
};

/**
 * Look at two domains and see if they match by taking into account any * wildcards.
 * @param wildCardDomain
 * @param referrer {string}
 * @returns {boolean} true if domains match
 */
module.exports.testDomainsMatch = function(wildCardDomain, referrer) {
    var isMatch = true,
        i,
        domainParts,
        referrerParts;

    domainParts = wildCardDomain.split('.');
    referrerParts = referrer.split('.');
    if (domainParts.length == referrerParts.length) {
        for (i = 0; i < domainParts.length; i ++) {
            if (domainParts[i] != '*' && domainParts[i] != referrerParts[i]) {
                isMatch = false;
                break;
            }
        }
    } else {
        isMatch = false;
    }
    return isMatch;
};

/**
 * Determine if two protocols match, accounting for wildcard in the first but not in the second.
 * Should also ignore :// (TODO?)
 * @param sourceProtocol
 * @param targetProtocol
 * @returns {boolean}
 */
module.exports.testProtocolsMatch = function(sourceProtocol, targetProtocol) {
    return sourceProtocol == '*' || sourceProtocol == targetProtocol;
};

/**
 * Compare two URL parts objects to determine if they match. Matching takes into account partial paths and
 * wildcards.
 * @param urlPartsSource
 * @param urlPartsTarget
 * @returns {boolean} returns true if the two objects are considered a match.
 */
module.exports.parsedUrlPartsMatch = function(urlPartsSource, urlPartsTarget) {
    var isMatch = false,
        errorMessage = '';

    if (this.testDomainsMatch(urlPartsSource.hostname, urlPartsTarget.hostname)) {
        if (urlPartsSource.protocol == "*" || urlPartsTarget.protocol == "*" || urlPartsSource.protocol == urlPartsTarget.protocol) {
            if (urlPartsSource.matchAll) {
                isMatch = urlPartsTarget.path == '*' || urlPartsTarget.path == urlPartsSource.path;
                if (isMatch) {
                    errorMessage = "parsedUrlPartsMatch path " + urlPartsSource.path + " " + urlPartsTarget.path + " match.";
                } else {
                    errorMessage = "parsedUrlPartsMatch path " + urlPartsSource.path + " " + urlPartsTarget.path + " don't match.";
                }
            } else {
                isMatch = urlPartsTarget.path == '*' || ProjectUtilities.startsWith(urlPartsTarget.path, urlPartsSource.path);
                if (isMatch) {
                    errorMessage = "parsedUrlPartsMatch path " + urlPartsSource.path + " " + urlPartsTarget.path + " match.";
                } else {
                    errorMessage = "parsedUrlPartsMatch path " + urlPartsSource.path + " " + urlPartsTarget.path + " don't match.";
                }
            }
        } else {
            errorMessage = "parsedUrlPartsMatch protocol " + urlPartsSource.protocol + " " + urlPartsTarget.protocol + " don't match.";
        }
    } else {
        errorMessage = "parsedUrlPartsMatch domains " + urlPartsSource.hostname + " " + urlPartsTarget.hostname + " don't match.";
    }
    if (errorMessage != '') {
        logMessage(errorMessage);
    }
    return isMatch;
};


/**
 * Determine if the referrer matches one of the configured allowed referrers. If it does, return the string
 * we store in our table as the look-up key for this referrer. If no match, return null.
 * @param referrer {string} referer (sic) received from http request
 * @param allowedReferrers {Array} array of parsed referrer URL objects to match referrer against.
 * @returns {string} the referrer we want to use when referring to this referrer.
 */
module.exports.validatedReferrerFromReferrer = function(referrer, allowedReferrers) {
    var validReferrer = null,
        i,
        noMatchReason = '',
        referrerToCheckParts,
        referrerParts;

    if (allowAnyReferrer) {
        validReferrer = '*';
    } else if (referrer != undefined && referrer != null && referrer.length > 0) {
        referrerParts = this.parseAndFixURLParts(referrer.toLowerCase().trim());
        if (referrerParts.hostname == null) {
            referrerParts.hostname = '*';
        }
        for (i = 0; i < allowedReferrers.length; i ++) {
            referrerToCheckParts = allowedReferrers[i];
            if (this.testProtocolsMatch(referrerToCheckParts.protocol, referrerParts.protocol)) {
                if (referrerToCheckParts.hostname == '*' || this.testDomainsMatch(referrerToCheckParts.hostname, referrerParts.hostname)) {
                    if (referrerToCheckParts.path == '*' || referrerToCheckParts.path == referrerParts.path) {
                        validReferrer = referrerToCheckParts.referrer;
                        break;
                    } else if (! matchAllReferrer && ProjectUtilities.startsWith(referrerParts.path, referrerToCheckParts.path)) {
                        validReferrer = referrerToCheckParts.referrer;
                        break;
                    } else {
                        noMatchReason = 'referrer path ' + referrerParts.path + ' does not match ' + referrerToCheckParts.path;
                    }
                } else {
                    noMatchReason = 'referrer hostname ' + referrerParts.hostname + ' does not match ' + referrerToCheckParts.hostname;
                }
            } else {
                noMatchReason = 'referrer protocol ' + referrerParts.protocol + ' does not match ' + referrerToCheckParts.protocol;
            }
        }
    } else {
        noMatchReason = 'referrer could not be determined and referrer match is required.';
    }
    if (noMatchReason != '') {
        logMessage('validatedReferrerFromReferrer no match because ' + noMatchReason);
    }
    return validReferrer;
};

/**
 * Try to determine the protocol to use given the parameters. This does a best-guess by prioritizing the
 * serverURLInfo definition, then the request that came in, and then use what the referrer came in with.
 * Finally if none of that produce a usable protocol we use the configuration default setting.
 * @param referrer {string} the url of the referrer
 * @param urlRequestedParts
 * @param serverURLInfo
 * @returns {string} the protocol we should use for this request.
 */
module.exports.getBestMatchProtocol = function(referrer, urlRequestedParts, serverURLInfo) {
    var protocol = null,
        referrerParts = this.parseAndFixURLParts(referrer);

    if (serverURLInfo.protocol == '*') {
        if (urlRequestedParts.protocol == '*') {
            if (referrerParts.protocol !== undefined && referrerParts.protocol != '*') {
                protocol = referrerParts.protocol;
            }
        } else {
            protocol = urlRequestedParts.protocol;
        }
    } else {
        protocol = serverURLInfo.protocol;
    }
    if (protocol === undefined || protocol == null || protocol == '*') {
        protocol = useHTTPS ? 'https' : 'http';
    }
    return protocol;
};

/**
 * Try to determine the port to use given the parameters. This does a best-guess by prioritizing the
 * serverURLInfo definition, then the request that came in, and then use what the referrer came in with.
 * Finally if none of that produce a usable port we use the configuration default setting.
 * @param referrer {string} the url of the referrer
 * @param urlRequestedParts
 * @param serverURLInfo
 * @returns {number} the port we should use for this request.
 */
module.exports.getBestMatchPort = function(referrer, urlRequestedParts, serverURLInfo) {
    var port = 80,
        referrerParts = this.parseAndFixURLParts(referrer);

    if (serverURLInfo.port == '*') {
        if (urlRequestedParts.port == '*') {
            if (referrerParts.port !== undefined && referrerParts.port != '*') {
                port = referrerParts.port;
            }
        } else {
            port = urlRequestedParts.port;
        }
    } else {
        port = serverURLInfo.port;
    }
    if (port === undefined || port == null || port == '*') {
        port = 80;
    }
    return port;
};

/**
 * When we break apart full URLs acting as referrers into their constituent parts (e.g. using url.parse()) this function
 * will take that url object and return a single string representing the original referrer.
 * @param urlParts
 * @returns {*}
 */
module.exports.fullReferrerURLFromParts = function(urlParts) {
    if (urlParts != null) {
        if (urlParts.protocol == '*' && urlParts.hostname == '*' && urlParts.path == '*') {
            return '*';
        } else {
            return urlParts.protocol + '://' + urlParts.hostname + (urlParts.path.charAt(0) == '/' ? urlParts.path : '/' + urlParts.path);
        }
    } else {
        return '*';
    }
};

/**
 * Given an object representing our URL parts structure this function will return a URL string
 * combining the constituent parts. This function will make some assumptions based on the data:
 *  - if protocol is * it will use https based on the global useHTTPS configuration setting.
 *  - if port is not null, *, or 80 it will add port: to the url, otherwise it ignores port.
 *  - if path is * it uses / instead, however if path ends with * it will remain.
 *  - if there is a query string it will be appended to the end of the path.
 * @param urlParts
 * @returns {string}
 */
module.exports.buildFullURLFromParts = function(urlParts) {
    var url;
    url = urlParts.protocol == '*' ? (useHTTPS ? 'https' : 'http') : urlParts.protocol;
    url += '://';
    url += urlParts.hostname;
    if (urlParts.port != '*' && urlParts.port != 80) {
        url += ':' + urlParts.port;
    }
    if (urlParts.pathname == '*' || urlParts.pathname.trim().length == 0) {
        url += '/';
    } else {
        url += urlParts.pathname;
    }
    if (urlParts.query !== undefined && urlParts.query != null && urlParts.query.length > 0) {
        if (urlParts.query.charAt(0) == '?') {
            url += urlParts.query;
        } else {
            url += '?' + urlParts.query;
        }
    }
    return url;
};

/**
 * Determine if the URL parts structure is valid enough to use as a URL.
 * @param urlParts
 * @returns {boolean}
 */
module.exports.isValidURL = function(urlParts) {
    return urlParts.protocol !== undefined && urlParts.protocol != null && urlParts.protocol.trim().length > 0
           && urlParts.hostname !== undefined && urlParts.hostname != null && urlParts.hostname.trim().length > 0
           && urlParts.pathname !== undefined && urlParts.pathname != null;
};

/**
 * Our parsing technique breaks resource requests into their individual pieces to make matching easier at
 * runtime (we don't have to parse everything on every request) but that requires us to reassemble a valid
 * resource request from those pieces plus any additional information that came in with the request.
 * @param referrer {string} the validated referrer we are tracking (can be "*").
 * @param urlRequestedParts {object} request parsed from parseURLRequest()
 * @param serverURLInfo {object} the serverUrl config that matches this request
 * @returns {string} a full URL to use to complete the request.
 */
module.exports.buildURLFromReferrerRequestAndInfo = function(referrer, urlRequestedParts, serverURLInfo) {
    var proxyRequest = serverURLInfo.url,
        delimiter;

    // make sure the url has a protocol. We allow url definitions to use no protocol or '*' or '*://' to mean
    // any protocol.
    delimiter = proxyRequest.indexOf('://');
    if (delimiter < 0) {
        // no ://
        proxyRequest = this.getBestMatchProtocol(referrer, urlRequestedParts, serverURLInfo) + '://' + proxyRequest;
    } else if (delimiter == 0) {
        // has just ://
        proxyRequest = this.getBestMatchProtocol(referrer, urlRequestedParts, serverURLInfo) + proxyRequest;
    } else if (delimiter == 1) {
        // has just ?://, check if *
        if (proxyRequest.charAt(0) == '*') {
            proxyRequest = this.getBestMatchProtocol(referrer, urlRequestedParts, serverURLInfo) + proxyRequest.substr(1);
        }
        //} else {
        // already has some protocol so just leave it alone
    }
    // add the query string to the end of the url
    if (serverURLInfo.query != null && serverURLInfo.query != '') {
        proxyRequest += '?' + serverURLInfo.query;
    } else if (urlRequestedParts.query != null && urlRequestedParts.query != '') {
        proxyRequest += '?' + urlRequestedParts.query;
    }
    return proxyRequest;
};

/**
 * Combine the parameters from the request and the server url configuration where the parameters
 * specified in the request will override any defined in the configuration, otherwise any parameters
 * specified in either are combined.
 * @param request - the node http/http request. It may also include parameters for the request.
 * @param urlParts - the parsed url parts of the request
 * @param serverURLInfo - the server url configuration matching the request. It may have its own parameters.
 * @returns {object} - recombined parameters.
 */
module.exports.combineParameters = function(request, urlParts, serverURLInfo) {
    var configuredParameters = {},
        requestParameters = null,
        key;

    if (serverURLInfo.query !== undefined && serverURLInfo.query != null && serverURLInfo.query.length > 0) {
        configuredParameters = ProjectUtilities.queryStringToObject(serverURLInfo.query);
    }
    if (request.method == 'GET') {
        if (urlParts.query !== undefined && urlParts.query != null && urlParts.query.length > 0) {
            requestParameters = urlParts.query;
        }
    } else if (request.method == 'POST') {
        // TODO: If POST then where are the post params?
        requestParameters = request.query;
    }
    if (requestParameters != null) {
        requestParameters = ProjectUtilities.queryStringToObject(requestParameters);
        for (key in requestParameters) {
            if (requestParameters.hasOwnProperty(key)) {
                configuredParameters[key] = requestParameters[key];
            }
        }
    }
    return configuredParameters;
};
