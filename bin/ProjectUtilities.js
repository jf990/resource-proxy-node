/**
 * Project utility functions: a compendium of miscellaneous JavaScript helper functions that we tend to reuse on
 * lots of projects.
 */

/**
 * Convert time in milliseconds into a printable hh:mm:ss string. Hours is not constrained.
 * @param timeInMilliseconds
 * @returns {string}
 */
module.exports.formatMillisecondsToHHMMSS = function(timeInMilliseconds) {
    var hours,
        minutes,
        seconds = timeInMilliseconds / 1000;
    hours = Math.floor(seconds / 3600);
    minutes = Math.floor(seconds / 60) % 60;
    seconds = Math.floor(seconds) % 60;
    return (hours < 10 ? '0' : '') + hours + ':' + ((minutes < 10 ? '0' : '') + minutes) + ':' + (seconds < 10 ? '0' : '') + seconds;
};

/**
 * Determine if the subject string starts with the needle string. Performs a case insensitive comparison.
 * @param subject
 * @param needle
 * @returns {boolean}
 */
module.exports.startsWith = function(subject, needle) {
    var subjectLowerCase = subject.toLowerCase(),
        needleLowerCase = needle.toLowerCase();
    return subjectLowerCase.indexOf(needleLowerCase) == 0;
};

/**
 * Determine if the subject string ends with the needle string. Performs a case insensitive comparison.
 * @param subject
 * @param needle
 * @returns {boolean}
 */
module.exports.endsWith = function(subject, needle) {
    var subjectLowerCase = subject.toLowerCase(),
        needleLowerCase = needle.toLowerCase(),
        startIndex = subjectLowerCase.length - needleLowerCase.length;
    return subjectLowerCase.indexOf(needleLowerCase, startIndex) == startIndex;
};

/**
 * Determine if a given configuration variable is set. Set would mean it is a property on the object and it is not empty.
 * @param object {object} subject to search.
 * @param key {string} key to look up in object.
 * @returns {boolean} true if key is a property of object.
 */
module.exports.isPropertySet = function(object, key) {
    var isSet = false;
    if (object[key] !== undefined) {
        isSet = object[key].toString().trim().length > 0;
    }
    return isSet;
};

/**
 * Determine if a given configuration variable is set. Set would mean it is a property on the object and it is not empty.
 * @param object {object} subject to search.
 * @param key {string} key to look up in object.
 * @param defaultValue {*} value to return if key is not found in object, or if the key in object has an empty value.
 * @returns {*} either the value of key in object, or the default value.
 */
module.exports.getIfPropertySet = function(object, key, defaultValue) {
    if (object[key] !== undefined && object[key].toString().trim().length > 0) {
        return object[key];
    } else {
        return defaultValue;
    }
};

/**
 * Add a key/value pair to an existing object only if the key does not already exist or if the key exists but
 * it is empty. If the key exists with a non-empty value then its value is not changed.
 * @param object {object} to check and possibly alter.
 * @param key {string} key to look up in object.
 * @param value {*} value to set to key if key does not exist in object.
 * @returns {object} return the object
 */
module.exports.addIfPropertyNotSet = function(object, key, value) {
    if (object[key] === undefined || object[key] == null || object[key].toString().trim().length == 0) {
        object[key] = value;
    }
    return object;
};

/**
 * Return the current document query string as an object with
 * key/value pairs converted to properties.
 *
 * @method queryStringToObject
 * @param urlParameterString {string} A query string to parse as the key value pairs (key=value&key=value) string.
 * @return {object} result The query string converted to an object of key/value pairs.
 */
module.exports.queryStringToObject = function(urlParameterString) {
    var match,
        search = /([^&=]+)=?([^&]*)/g,
        decode = function (s) {
            return decodeURIComponent(s.replace(/\+/g, ' '));
        },
        result = {};
    if (urlParameterString.charAt(0) == '?') {
        urlParameterString = urlParameterString.substr(1);
    }
    while (match = search.exec(urlParameterString)) {
        result[decode(match[1])] = decode(match[2]);
    }
    return result;
};

/**
 * Return the query string representation of an object with key/value pairs converted to string.
 * Does not handle recursion, but will flatten an array. Values are url encoded. ? is not added to the result.
 *
 * @method objectToQueryString
 * @param {object} object The object of key/value pairs.
 * @return {string} urlParamterString A query string (key=value&key=value).
 */
module.exports.objectToQueryString = function(object) {
    var urlParameterString = '',
        key,
        value;

    if (object !== undefined && object != null) {
        for (key in object) {
            if (object.hasOwnProperty(key)) {
                value = object[key];
                if (value === undefined || value === null) {
                    continue;
                } else if (Array.isArray(value)) {
                    value = value.join(',');
                } else {
                    value = value.toString();
                }
                value = encodeURIComponent(value);
                key = encodeURIComponent(key);
                urlParameterString += (urlParameterString.length == 0 ? '' : '&') + key + '=' + value;
            }
        }
    }
    return urlParameterString;
};

/**
 * Look for the token in a string that is assumed to be either a URL query string or a JSON string. If the
 * token is found the value is returned. This is useful when you need to pull out one value from a large string
 * and you don't want to convert that large string into yet another memory-hogging object/array data structure and
 * then traverse the structure to try to identify one value.
 * @param source {string} string to search and extract
 * @param token {string} the token we are looking for in source.
 * @return {string} the value of the token, '' if not found.
 */
module.exports.findTokenInString = function(source, token) {
    var found,
        searchToken,
        value = '';

    if (source !== undefined && token !== undefined && source.trim().length > 0 && token.trim().length > 0) {
        searchToken = '(\\?|&|\\/|)' + token + '=';
        found = source.search(searchToken);
        if (found >= 0) {
            // found query string style &token=value, cut from = to next & or EOS
            value = source.substr(found);
            found = value.indexOf('=');
            if (found >= 0) {
                value = value.substr(found + 1);
                found = value.indexOf('&');
                if (found > 0) {
                    value = value.substr(0, found);
                }
            }
        } else {
            // found json style "token": "value", get quoted value
            searchToken = '"' + token +'":';
            found = source.search(searchToken);
            if (found >= 0) {
                value = source.substr(found + searchToken.length);
                searchToken = '"([^"]*)"'; // find next quoted string
                value = value.match(searchToken);
                if (value != null) {
                    value = value[1];
                } else {
                    value = '';
                }
            }
        }
    }
    return value;
};

/**
 * Look for the token in a string that is assumed to be either a URL query string or a JSON string. If the
 * token is found the value is returned. This is useful when you need to pull out one value from a large string
 * and you don't want to convert that large string into yet another memory-hogging object/array data structure and
 * then traverse the structure to try to identify one value.
 * @param source {string} string to search and extract
 * @param token {string} the token we are looking for in source.
 * @return {number} the value of the token, 0 if not found.
 */
module.exports.findNumberAfterTokenInString = function(source, token) {
    var found,
        searchToken,
        value = 0;

    if (source !== undefined && token !== undefined && source.trim().length > 0 && token.trim().length > 0) {
        searchToken = '(\\?|&|\\/|)' + token + '=';
        found = source.search(searchToken);
        if (found >= 0) {
            // found query string style &token=value, cut from = to next & or EOS
            value = source.substr(found);
            found = value.indexOf('=');
            if (found >= 0) {
                value = value.substr(found + 1);
                found = value.indexOf('&');
                if (found > 0) {
                    value = value.substr(0, found);
                }
            }
        } else {
            // found json style "token": value, get next number value
            searchToken = '"' + token +'":';
            found = source.search(searchToken);
            if (found >= 0) {
                value = source.substr(found + searchToken.length);
                value = parseInt(value);
            }
        }
    }
    return value;
};

/**
 * Return true if the file name appears to be a json file type (because it ends with .json).
 * @param fileName
 * @returns {boolean}
 */
module.exports.isFileTypeJson = function (fileName) {
    var regex = /\.json$/i;
    return regex.test(fileName, 'i');
};