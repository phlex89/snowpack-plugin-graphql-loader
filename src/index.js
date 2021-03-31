const fs = require("fs");
const os = require("os");
const gql = require("graphql-tag");

// This is heavily inspired by the most recent version of graphql-tag/loader
// but it is rewritten to output snowpack friendly code, with imports rather
// than requires
// Original inspiration:
// https://github.com/apollographql/graphql-tag/blob/6d2f4a8a21536f7f333dbb31dab604a1a9dc8d1a/loader.js#L1

// Takes `source` (the source GraphQL query string)
// and `doc` (the parsed GraphQL document) and tacks on
// the imported definitions.

let uniques = `
    var names = {};
    function unique(defs) {
      return defs.filter(
        function(def) {
          if (def.kind !== 'FragmentDefinition') return true;
          var name = def.name.value
          if (names[name]) {
            return false;
          } else {
            names[name] = true;
            return true;s
          }
        }
      )
    }
  `;

function expandImports(source, doc) {
  const lines = source.split(/\r\n|\r|\n/);

  const imports = [];

  lines.some((line) => {
    if (line[0] === "#" && line.slice(1).split(" ")[0] === "import") {
      const importFile = line.slice(1).split(" ")[1];
      imports.push(importFile);
    }
    return line.length !== 0 && line[0] !== "#";
  });

  return imports;
}

function loadToDocumentNodes(source) {
  const doc = gql`
    ${source}
  `;
  let headerCode = `
    var doc = ${JSON.stringify(doc)};
    doc.loc.source = ${JSON.stringify(doc.loc.source)};
  `;

  let outputCode = "";

  // Allow multiple query/mutation definitions in a file. This parses out dependencies
  // at compile time, and then uses those at load time to create minimal query documents
  // We cannot do the latter at compile time due to how the #import code works.
  let operationCount = doc.definitions.reduce(function (accum, op) {
    if (op.kind === "OperationDefinition") {
      return accum + 1;
    }

    return accum;
  }, 0);

  if (operationCount < 1) {
    outputCode += `
      export default doc;
    `;
  } else {
    outputCode += `
    // Collect any fragment/type references from a node, adding them to the refs Set
    function collectFragmentReferences(node, refs) {
      if (node.kind === "FragmentSpread") {
        refs.add(node.name.value);
      } else if (node.kind === "VariableDefinition") {
        var type = node.type;
        if (type.kind === "NamedType") {
          refs.add(type.name.value);
        }
      }
      if (node.selectionSet) {
        node.selectionSet.selections.forEach(function(selection) {
          collectFragmentReferences(selection, refs);
        });
      }
      if (node.variableDefinitions) {
        node.variableDefinitions.forEach(function(def) {
          collectFragmentReferences(def, refs);
        });
      }
      if (node.definitions) {
        node.definitions.forEach(function(def) {
          collectFragmentReferences(def, refs);
        });
      }
    }
    var definitionRefs = {};
    (function extractReferences() {
      doc.definitions.forEach(function(def) {
        if (def.name) {
          var refs = new Set();
          collectFragmentReferences(def, refs);
          definitionRefs[def.name.value] = refs;
        }
      });
    })();
    function findOperation(doc, name) {
      for (var i = 0; i < doc.definitions.length; i++) {
        var element = doc.definitions[i];
        if (element.name && element.name.value == name) {
          return element;
        }
      }
    }
    function oneQuery(doc, operationName) {
      // Copy the DocumentNode, but clear out the definitions
      var newDoc = {
        kind: doc.kind,
        definitions: [findOperation(doc, operationName)]
      };
      if (doc.hasOwnProperty("loc")) {
        newDoc.loc = doc.loc;
      }
      // Now, for the operation we're running, find any fragments referenced by
      // it or the fragments it references
      var opRefs = definitionRefs[operationName] || new Set();
      var allRefs = new Set();
      var newRefs = new Set();
      // IE 11 doesn't support "new Set(iterable)", so we add the members of opRefs to newRefs one by one
      opRefs.forEach(function(refName) {
        newRefs.add(refName);
      });
      while (newRefs.size > 0) {
        var prevRefs = newRefs;
        newRefs = new Set();
        prevRefs.forEach(function(refName) {
          if (!allRefs.has(refName)) {
            allRefs.add(refName);
            var childRefs = definitionRefs[refName] || new Set();
            childRefs.forEach(function(childRef) {
              newRefs.add(childRef);
            });
          }
        });
      }
      allRefs.forEach(function(refName) {
        var op = findOperation(doc, refName);
        if (op) {
          newDoc.definitions.push(op);
        }
      });
      return newDoc;
    }
    export default doc;
    `;

    for (const op of doc.definitions) {
      if (op.kind === "OperationDefinition") {
        if (!op.name) {
          if (operationCount > 1) {
            throw "Query/mutation names are required for a document with multiple definitions";
          } else {
            continue;
          }
        }

        const opName = op.name.value;
        outputCode += `
        export const ${opName} = oneQuery(doc, "${opName}");
        `;
      }
    }
  }

  const imports = expandImports(source, doc);

  const allCode =
    imports
      .map((importFile, index) => `import f${index} from ${importFile}`)
      .join("\n") +
    uniques +
    headerCode +
    imports
      .map(
        (importFile, index) =>
          `doc.definitions = doc.definitions.concat(unique(f${index}.definitions));`
      )
      .join("\n") +
    os.EOL +
    os.EOL +
    outputCode +
    os.EOL;

  return allCode;
}

const plugin = () => ({
  name: "grapqhl-plugin",
  resolve: {
    input: [".graphql"],
    output: [".js"],
  },
  async load({ filePath }) {
    const fileContents = fs.readFileSync(filePath, "utf-8");
    return {
      ".js": loadToDocumentNodes(fileContents),
    };
  },
});

export default plugin;
