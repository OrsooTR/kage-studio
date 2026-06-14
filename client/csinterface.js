/*
 * Minimal CSInterface — just the pieces this panel needs:
 * evalScript, getSystemPath, getApplicationID, and host-version detection.
 * Backed by the CEP-injected window.__adobe_cep__ object.
 */
function SystemPath() {}
SystemPath.USER_DATA = "userData";
SystemPath.COMMON_FILES = "commonFiles";
SystemPath.MY_DOCUMENTS = "myDocuments";
SystemPath.APPLICATION = "application";
SystemPath.EXTENSION = "extension";
SystemPath.HOST_APPLICATION = "hostApplication";

function CSInterface() {}

CSInterface.prototype.hostEnvironment =
    (typeof window !== "undefined" && window.__adobe_cep__)
        ? JSON.parse(window.__adobe_cep__.getHostEnvironment())
        : null;

CSInterface.prototype.evalScript = function (script, callback) {
    if (callback === null || callback === undefined) callback = function () {};
    window.__adobe_cep__.evalScript(script, callback);
};

CSInterface.prototype.getApplicationID = function () {
    return this.hostEnvironment ? this.hostEnvironment.appId : "";
};

CSInterface.prototype.getSystemPath = function (pathType) {
    var path = window.__adobe_cep__.getSystemPath(pathType);
    var OSVersion = navigator.userAgent;
    if (OSVersion.indexOf("Windows") >= 0) {
        path = path.replace(/\//g, "\\");
    }
    return decodeURIComponent(path);
};

CSInterface.prototype.getHostEnvironment = function () {
    this.hostEnvironment = JSON.parse(window.__adobe_cep__.getHostEnvironment());
    return this.hostEnvironment;
};

CSInterface.prototype.openURLInDefaultBrowser = function (url) {
    if (window.cep && window.cep.util) return window.cep.util.openURLInDefaultBrowser(url);
};
