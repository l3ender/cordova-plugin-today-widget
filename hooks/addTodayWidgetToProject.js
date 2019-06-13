// @ts-check

var fs = require('fs');
var path = require('path');
var plist = require('plist');

function log(logString, type) {
  var prefix;
  var postfix = '';
  switch (type) {
    case 'error':
      prefix = '\x1b[1m' + '\x1b[31m' + '💥 😨 '; // bold, red
      throw new Error(prefix + logString + 'x1b[0m'); // reset
    case 'info':
      prefix =
        '\x1b[40m' +
        '\x1b[37m' +
        '\x1b[2m' +
        '☝️ [INFO] ' +
        '\x1b[0m\x1b[40m' +
        '\x1b[33m'; // fgWhite, dim, reset, bgBlack, fgYellow
      break;
    case 'start':
      prefix = '\x1b[40m' + '\x1b[36m'; // bgBlack, fgCyan
      break;
    case 'success':
      prefix = '\x1b[40m' + '\x1b[32m' + '✔ '; // bgBlack, fgGreen
      postfix = ' 🦄  🎉  🤘';
      break;
  }

  console.log(prefix + logString + postfix);
}

function getPreferenceValue(config, name) {
  var value = config.match(
    new RegExp('name="' + name + '" value="(.*?)"', 'i')
  );
  if (value && value[1]) {
    return value[1];
  } else {
    return null;
  }
}

function replacePlaceholdersInPlist(plistPath, placeHolderValues) {
  var plistContents = fs.readFileSync(plistPath, 'utf8');
  for (var i = 0; i < placeHolderValues.length; i++) {
    var placeHolderValue = placeHolderValues[i],
      regexp = new RegExp(placeHolderValue.placeHolder, 'g');
    plistContents = plistContents.replace(regexp, placeHolderValue.value);
  }
  fs.writeFileSync(plistPath, plistContents);
}

function getCordovaParameter(variableName, contents) {
  var variable;
  if (process.argv.join('|').indexOf(variableName + '=') > -1) {
    var re = new RegExp(variableName + '=(.*?)(||$))', 'g');
    variable = process.argv.join('|').match(re)[1];
  } else {
    variable = getPreferenceValue(contents, variableName);
  }
  return variable;
}

module.exports = function(context) {
  var xcode = context.requireCordovaModule('xcode');
  var Q = context.requireCordovaModule('q');
  var deferral = new Q.defer();

  if (
    process.env.INCLUDE_APP_EXTENSIONS &&
    process.env.INCLUDE_APP_EXTENSIONS == 'false'
  ) {
    return;
  }

  console.log('\x1b[40m');
  log(
    'Running addTargetToXcodeProject hook, patching xcode project 🦄 ',
    'start'
  );

  if (context.opts.cordova.platforms.indexOf('ios') < 0) {
    log('You have to add the ios platform before adding this plugin!', 'error');
  }

  var contents = fs.readFileSync(
    path.join(context.opts.projectRoot, 'config.xml'),
    'utf-8'
  );

  // Get the plugin variables from the parameters or the config file
  var WIDGET_NAME = getCordovaParameter('WIDGET_NAME', contents);
  var WIDGET_BUNDLE_SUFFIX = getCordovaParameter(
    'WIDGET_BUNDLE_SUFFIX',
    contents
  );
  var ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES = getCordovaParameter(
    'ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES',
    contents
  );
  var SWIFT_VERSION = getCordovaParameter('SWIFT_VERSION', contents);
  var CUSTOM_FRAMEWORKS = getCordovaParameter('CUSTOM_FRAMEWORKS', contents);

  if (contents) {
    contents = contents.substring(contents.indexOf('<'));
  }

  // Get the bundle-id from config.xml
  var elementTree = context.requireCordovaModule('elementtree');
  var etree = elementTree.parse(contents);
  var bundleId = etree.getroot().get('id');
  log('Bundle id of your host app: ' + bundleId, 'info');

  var iosFolder = context.opts.cordova.project
    ? context.opts.cordova.project.root
    : path.join(context.opts.projectRoot, 'platforms/ios/');
  log('Folder containing your iOS project: ' + iosFolder, 'info');

  fs.readdir(iosFolder, function(err, data) {
    var projectFolder;
    var projectName;
    var run = function() {
      var pbxProject;
      var projectPath;
      projectPath = path.join(projectFolder, 'project.pbxproj');

      log(
        'Parsing existing project at location: ' + projectPath + ' ...',
        'info'
      );
      if (context.opts.cordova.project) {
        pbxProject = context.opts.cordova.project.parseProjectFile(
          context.opts.projectRoot
        ).xcode;
      } else {
        pbxProject = xcode.project(projectPath);
        pbxProject.parseSync();
      }

      var widgetName = WIDGET_NAME || projectName + ' Widget';
      log('Your widget will be named: ' + widgetName, 'info');

      var widgetBundleId = WIDGET_BUNDLE_SUFFIX || 'widget';
      log(
        'Your widget bundle id will be: ' + bundleId + '.' + widgetBundleId,
        'info'
      );

      var widgetFolder = path.join(iosFolder, widgetName);
      var sourceFiles = [];
      var resourceFiles = [];
      var configFiles = [];
      var projectContainsSwiftFiles = false;
      var addBridgingHeader = false;
      var bridgingHeaderName;
      var addXcconfig = false;
      var xcconfigFileName;
      var xcconfigReference;
      var addEntitlementsFile = false;
      var entitlementsFileName;
      var plistFilePath;
      var projectPlistPath = path.join(
        iosFolder,
        projectName,
        projectName + '-Info.plist'
      );
      var projectPlistJson = plist.parse(
        fs.readFileSync(projectPlistPath, 'utf8')
      );
      var placeHolderValues = [
        {
          placeHolder: '__DISPLAY_NAME__',
          value: projectPlistJson['CFBundleDisplayName'],
        },
        {
          placeHolder: '__APP_IDENTIFIER__',
          value: projectPlistJson['CFBundleIdentifier'],
        },
        {
          placeHolder: '__BUNDLE_SUFFIX__',
          value: widgetBundleId,
        },
        {
          placeHolder: '__BUNDLE_SHORT_VERSION_STRING__',
          value: projectPlistJson['CFBundleShortVersionString'],
        },
        {
          placeHolder: '__BUNDLE_VERSION__',
          value: projectPlistJson['CFBundleVersion'],
        },
      ];

      // https://stackoverflow.com/a/16684530/1880761
      var walk = function(dir, ignoreDirs = []) {
        let results = [];
        let list = fs.readdirSync(dir);
        list.forEach(function(fileName) {
          let filePath = path.join(dir, fileName);
          let stat = fs.statSync(filePath);
          if (ignoreDirs.includes(fileName)) {
            return;
          } else if (stat && stat.isDirectory()) {
            /* Recurse into a subdirectory */
            results = results.concat(walk(filePath, ignoreDirs));
          } else {
            /* Is a file */
            results.push(filePath);
          }
        });
        return results;
      };

      var frameworkDirNames = [];
      if (CUSTOM_FRAMEWORKS) {
        CUSTOM_FRAMEWORKS.split(',').forEach(customFramework => {
          frameworkDirNames.push(path.basename(customFramework));
        });
      }

      walk(widgetFolder, frameworkDirNames).forEach(filePath => {
        let fileExtension = path.extname(filePath);
        if (fileExtension) {
          // Ignore junk files like .DS_Store
          let fileName = path.basename(filePath);
          switch (fileExtension) {
            // Swift and Objective-C source files which need to be compiled
            case '.swift':
              projectContainsSwiftFiles = true;
              sourceFiles.push(filePath);
              break;
            case '.h':
            case '.m':
              if (fileName === 'Bridging-Header.h' || fileName === 'Header.h') {
                addBridgingHeader = true;
                bridgingHeaderName = fileName;
              }
              sourceFiles.push(filePath);
              break;
            // Configuration files
            case '.plist':
            case '.entitlements':
            case '.xcconfig':
              if (fileExtension === '.plist') {
                replacePlaceholdersInPlist(filePath, placeHolderValues);
                plistFilePath = filePath.replace(iosFolder, '');
              }
              if (fileExtension === '.xcconfig') {
                addXcconfig = true;
                xcconfigFileName = fileName;
              }
              if (fileExtension === '.entitlements') {
                replacePlaceholdersInPlist(filePath, placeHolderValues);
                addEntitlementsFile = true;
                entitlementsFileName = fileName;
              }
              configFiles.push(filePath);
              break;
            // Resources like storyboards, images, fonts, etc.
            default:
              resourceFiles.push(filePath);
              break;
          }
        }
      });

      log('Found following files in your widget folder:', 'info');
      console.log('Source-files: ');
      sourceFiles.forEach(file => {
        console.log(' - ', file);
      });

      console.log('Config-files: ');
      configFiles.forEach(file => {
        console.log(' - ', file);
      });

      console.log('Resource-files: ');
      resourceFiles.forEach(file => {
        console.log(' - ', file);
      });

      // Add PBXNativeTarget to the project
      var target = pbxProject.addTarget(
        widgetName,
        'app_extension',
        widgetName
      );
      if (target) {
        log('Successfully added PBXNativeTarget!', 'info');
      }

      // Create a separate PBXGroup for the widgets files, name has to be unique and path must be in quotation marks
      var pbxGroupKey = pbxProject.pbxCreateGroup(
        'Widget',
        '"' + widgetName + '"'
      );
      if (pbxGroupKey) {
        log(
          'Successfully created empty PbxGroup for folder: ' +
            widgetName +
            ' with alias: Widget',
          'info'
        );
      }

      // Add the PbxGroup to cordovas "CustomTemplate"-group
      var customTemplateKey = pbxProject.findPBXGroupKey({
        name: 'CustomTemplate',
      });
      pbxProject.addToPbxGroup(pbxGroupKey, customTemplateKey);
      log(
        'Successfully added the widgets PbxGroup to cordovas CustomTemplate!',
        'info'
      );

      // Add files which are not part of any build phase (config)
      configFiles.forEach(configFile => {
        var file = pbxProject.addFile(
          configFile.replace(widgetFolder + '/', ''),
          pbxGroupKey
        );
        // We need the reference to add the xcconfig to the XCBuildConfiguration as baseConfigurationReference
        if (path.extname(configFile) == '.xcconfig') {
          xcconfigReference = file.fileRef;
        }
      });
      log(
        'Successfully added ' + configFiles.length + ' configuration files!',
        'info'
      );

      // Add a new PBXSourcesBuildPhase for our TodayViewController (we can't add it to the existing one because a today extension is kind of an extra app)
      var sourcesBuildPhase = pbxProject.addBuildPhase(
        [],
        'PBXSourcesBuildPhase',
        'Sources',
        target.uuid
      );
      if (sourcesBuildPhase) {
        log('Successfully added PBXSourcesBuildPhase!', 'info');
      }

      // Add a new source file and add it to our PbxGroup and our newly created PBXSourcesBuildPhase
      sourceFiles.forEach(sourcefile => {
        pbxProject.addSourceFile(
          sourcefile.replace(widgetFolder + '/', ''),
          { target: target.uuid },
          pbxGroupKey
        );
      });

      log(
        'Successfully added ' +
          sourceFiles.length +
          ' source files to PbxGroup and PBXSourcesBuildPhase!',
        'info'
      );

      // Add a new PBXFrameworksBuildPhase for the Frameworks used by the widget (NotificationCenter.framework, libCordova.a)
      var frameworksBuildPhase = pbxProject.addBuildPhase(
        [],
        'PBXFrameworksBuildPhase',
        'Frameworks',
        target.uuid
      );
      if (frameworksBuildPhase) {
        log('Successfully added PBXFrameworksBuildPhase!', 'info');
      }

      var coreFrameworks = ['NotificationCenter.framework', 'libCordova.a'];
      coreFrameworks.forEach(framework => {
        var frameworkFile = pbxProject.addFramework(framework, {
          target: target.uuid,
        });
        if (frameworkFile) {
          log(
            "Successfully added core framework '" +
              framework +
              "' needed by the widget!",
            'info'
          );
        }
      });

      // Add a new PBXResourcesBuildPhase for the Resources used by the widget (MainInterface.storyboard)
      var resourcesBuildPhase = pbxProject.addBuildPhase(
        [],
        'PBXResourcesBuildPhase',
        'Resources',
        target.uuid
      );
      if (resourcesBuildPhase) {
        log('Successfully added PBXResourcesBuildPhase!', 'info');
      }

      //  Add the resource file and include it into the targest PbxResourcesBuildPhase and PbxGroup
      resourceFiles.forEach(resourcefile => {
        pbxProject.addResourceFile(
          resourcefile.replace(widgetFolder + '/', ''),
          { target: target.uuid },
          pbxGroupKey
        );
      });

      log(
        'Successfully added ' + resourceFiles.length + ' resource files!',
        'info'
      );

      // Add build settings for Swift support, bridging header and xcconfig files
      var configurations = pbxProject.pbxXCBuildConfigurationSection();
      for (var key in configurations) {
        if (typeof configurations[key].buildSettings !== 'undefined') {
          var buildSettingsObj = configurations[key].buildSettings;
          if (typeof buildSettingsObj['PRODUCT_NAME'] !== 'undefined') {
            var productName = buildSettingsObj['PRODUCT_NAME'];
            if (productName.indexOf(widgetName) >= 0) {
              if (addXcconfig) {
                configurations[key].baseConfigurationReference =
                  xcconfigReference + ' /* ' + xcconfigFileName + ' */';
                log('Added xcconfig file reference to build settings!', 'info');
              }
              if (addEntitlementsFile) {
                buildSettingsObj['CODE_SIGN_ENTITLEMENTS'] =
                  '"' + widgetName + '/' + entitlementsFileName + '"';
                log(
                  'Added entitlements file reference to build settings!',
                  'info'
                );
              }
              if (projectContainsSwiftFiles) {
                buildSettingsObj['SWIFT_VERSION'] = SWIFT_VERSION || '3.0';
                buildSettingsObj['ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES'] =
                  ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES || 'YES';
                log('Added build settings for swift support!', 'info');
              }
              if (addBridgingHeader) {
                buildSettingsObj['SWIFT_OBJC_BRIDGING_HEADER'] =
                  '"$(PROJECT_DIR)/' +
                  widgetName +
                  '/' +
                  bridgingHeaderName +
                  '"';
                log(
                  'Added bridging header reference to build settings!',
                  'info'
                );
              }
              if (frameworkDirNames.length > 0) {
                let INHERITED = '"$(inherited)"';
                if (
                  !buildSettingsObj['FRAMEWORK_SEARCH_PATHS'] ||
                  buildSettingsObj['FRAMEWORK_SEARCH_PATHS'] === INHERITED
                ) {
                  buildSettingsObj['FRAMEWORK_SEARCH_PATHS'] = [INHERITED];
                }
                buildSettingsObj['FRAMEWORK_SEARCH_PATHS'].push(
                  '"\\"' + widgetName + '\\""'
                );
                log(
                  'Added ' +
                    widgetName +
                    ' to build settings framework search path!',
                  'info'
                );
              }
              if (plistFilePath) {
                // update plist location in case it is in a subdirectory (info plist requires actual relative path)
                buildSettingsObj['INFOPLIST_FILE'] = '"' + plistFilePath + '"';
              }
            }
          }
        }
      }

      // Write the modified project back to disc
      log('Writing the modified project back to disk ...', 'info');
      fs.writeFileSync(projectPath, pbxProject.writeSync());
      log(
        'Added app extension to ' + projectName + ' xcode project',
        'success'
      );
      console.log('\x1b[0m'); // reset

      deferral.resolve();
    };

    if (err) {
      log(err, 'error');
    }

    // Find the project folder by looking for *.xcodeproj
    if (data && data.length) {
      data.forEach(function(folder) {
        if (folder.match(/\.xcodeproj$/)) {
          projectFolder = path.join(iosFolder, folder);
          projectName = path.basename(folder, '.xcodeproj');
        }
      });
    }

    if (!projectFolder || !projectName) {
      log('Could not find an *.xcodeproj folder in: ' + iosFolder, 'error');
    }

    run();
  });

  return deferral.promise;
};
