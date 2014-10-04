define("mode/c_cpp_matching_brace_outdent", function(require, exports, module) {

var Range = require("ace/range").Range;
var CppLookaroundHeuristics = require("mode/cpp_lookaround_heuristics").CppLookaroundHeuristics;

var MatchingBraceOutdent = function() {
   this.$heuristics = new CppLookaroundHeuristics();
};

(function() {

   // Set the indent of the line at 'row' to the indentation
   // at 'rowFrom'.
   this.setIndent = function(session, rowTo, rowFrom, extraIndent) {

      var doc = session.getDocument();
      extraIndent = typeof extraIndent === "string" ?
         extraIndent :
         "";

      var line = doc.$lines[rowTo];
      var lastLine = doc.$lines[rowFrom];

      var oldIndent = this.$getIndent(line);
      var newIndent = this.$getIndent(lastLine);

      doc.replace(
         new Range(rowTo, 0, rowTo, oldIndent.length),
         newIndent + extraIndent
      );
      
   };

   this.checkOutdent = function(state, line, input) {

      if (state == "start") {

         // private: / public: / protected
         // also class initializer lists
         if (input == ":") {
            return true;
         }

         // outdenting for '\'
         if (input == "\\") {
            return true;
         }

         // outdenting for lines starting with 'closers' and 'openers'
         if (/^\s*[\{\}\>\]\)<.:]/.test(input)) {
            return true;
         }

      }

      // check for nudging of '/' to the left (?)
      if (state == "comment") {

         if (input == "/") {
            return true;
         }

      }

      return false;

   };

   this.outdentBraceForNakedTokens = function(session, row, line, lastLine) {

      if (/^\s*\{/.test(line)) {
         var re = this.$heuristics.reNakedBlockTokens;
         if (lastLine !== null) {
            for (var key in re) {
               if (re[key].test(lastLine)) {
                  this.setIndent(session, row, row - 1);
                  return true;
               }
            }
         }
      }
      return false;
   };

   this.escapeRegExp = function(string) {
      return string.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&");
   };

   this.alignStartToken = function(token, session, row, line, lastLine) {

      if (lastLine === null || line === null) return false;
      var regex = new RegExp("^\\s*" + this.escapeRegExp(token));
      if (regex.test(line)) {
         var index = lastLine.indexOf(token);
         if (index >= 0) {

            var doc = session.getDocument();
            var oldIndent = this.$getIndent(line);
            var newIndent = new Array(index + 1).join(" ");

            doc.replace(
               new Range(row, 0, row, oldIndent.length),
               newIndent
            );

            return true;
         }
      }
      return false;
   };

   this.autoOutdent = function(state, session, row) {

      var doc = session.doc;
      var line = this.$heuristics.getLineSansComments(doc, row);
      var lastLine = null;
      if (row > 0)
         lastLine = this.$heuristics.getLineSansComments(doc, row - 1);
      var indent = this.$getIndent(line);

      // Check for naked token outdenting
      if (this.outdentBraceForNakedTokens(session, row, line, lastLine)) {
         return;
      }

      // Check for '<<', '.'alignment
      if (this.alignStartToken("<<", session, row, line, lastLine) ||
          this.alignStartToken(".", session, row, line, lastLine)) {
         return;
      }

      // Outdent for a ':' places on its own line if it appears the
      // user is creating an initialization list for
      // a constructor, e.g.
      //
      //     SomeConstructor(int a,
      //                     int b)
      //         :
      //         ^
      //
      if (/^\s*:/.test(line)) {

         var scopeRow = this.$heuristics.getRowForOpenBraceIndentClassStyle(
            session,
            row
         );

         if (scopeRow >= 0) {
            this.setIndent(session, row, scopeRow, session.getTabString());
         }
      }

      // If we just inserted a '>', find the matching '<' for indentation.
      //
      // But this runs into problems with indentation for use of the '>>'
      // operator on its own line, e.g.
      //
      //    std::cin >> foo
      //             >> bar
      //             >> baz;
      //
      if (/^\s*\>$/.test(line)) {

         var matchedRow = this.$heuristics.findMatchingBracketRow(
            ">",
            doc,
            row,
            50
         );

         if (matchedRow >= 0) {
            var matchedLine = this.$heuristics.getLineSansComments(doc, matchedRow);
            if (matchedLine.indexOf("<<") === -1) {
               this.setIndent(session, row, matchedRow);
               return;
            }
         }
      }

      // Outdent for closing braces (to match the indentation of their
      // matched opening brace
      //
      // If the line on which the matching '{' was found is of
      // the form
      //
      //  foo) {
      //
      // then indent according to the location of the matching
      // '('
      //
      // This rule should apply to closing braces with semi-colons
      // or comments following as well.
      if (/^\s*\}/.test(line)) {

         var openBracketPos = session.findMatchingBracket({
            row: row,
            column: line.indexOf("}") + 1
         });

         if (openBracketPos !== null) {

            // If the open brace lies on its own line, match its indentation
            var openBracketLine =
                   doc.$lines[openBracketPos.row].replace(/\/\/.*/, "");

            if (/^\s*\{\s*$/.test(openBracketLine)) {
               this.setIndent(session, row, openBracketPos.row);
               return;
            }

            // Otherwise, try looking upwards to get an appropriate indentation
            var heuristicRow = this.$heuristics.getRowForOpenBraceIndent(
               session,
               openBracketPos.row
            );

            if (heuristicRow !== null) {
               this.setIndent(session, row, heuristicRow);
               return;
            }

         } 

      }

      // Indentation for lines beginning with ']'. Match the
      // indentation of its associated '['.
      var closerMatch = /^\s*([\]\)])/.exec(line);
      if (closerMatch) {

         var openBracketPos = session.findMatchingBracket({
            row: row,
            column: line.lastIndexOf(closerMatch[1]) + 1
         });

         if (openBracketPos) {
            this.setIndent(session, row, openBracketPos.row);
            return;
         }
      }

      // If we just typed 'public:', 'private:' or 'protected:',
      // we should outdent if possible. Do so by looking for the
      // enclosing 'class' scope.
      if (/^\s*public\s*:|^\s*private\s*:|^\s*protected\s*:/.test(line)) {

         // Find the associated open bracket.
         var openBraceRow = this.$heuristics.doFindMatchingBracketRow(
            "}",
            doc,
            row,
            1E6,
            "backward",
            1,
            0
         );

         if (openBraceRow >= 0) {
            // If this open brace is already associated with a class or struct,
            // step over all of those rows.
            var heuristicRow =
                   this.$heuristics.getRowForOpenBraceIndent(session, openBraceRow);

            if (heuristicRow !== null && heuristicRow >= 0) {
               this.setIndent(session, row, heuristicRow);
               return;
            } else {
               this.setIndent(session, row, openBraceRow);
               return;
            }
         }
         
      }

      // Similar lookback for 'case foo:', but we have a twist: we want to walk
      // up rows, but in case we run into a 'case:' with indentation already set
      // in a different way from the auto-outdent, we match that indentation.
      //
      // This implies that e.g.
      //
      //     switch (x)
      //     {
      //         case Foo: bar; break;
      //         ^
      //
      // so we match the indentation of the 'case', rather than the open brace
      // associated with the switch.
      if (/^\s*case.+:/.test(line)) {

         // Find the associated open bracket.
         var openBraceRow = this.$heuristics.doFindMatchingBracketRow(
            "}",
            doc,
            row - 1,
            1E6,
            "backward",
            1,
            0,
            function(x) { return /^\s*case.+:/.test(x); }
         );

         if (openBraceRow >= 0) {
            var heuristicRow =
                   this.$heuristics.getRowForOpenBraceIndent(session, openBraceRow);

            if (heuristicRow !== null && heuristicRow >= 0) {
               this.setIndent(session, row, heuristicRow);
               return;
            } else {
               this.setIndent(session, row, openBraceRow);
               return;
            }
         }
         
      }
      

      // If we just inserted a '{' on a new line to begin a class definition,
      // try looking up for the associated class statement.
      // We want to look back over the following common indentation styles:
      //
      // (1) class Foo
      //     : public A,
      //       public B,
      //       public C
      //
      // and
      //
      // (2) class Foo
      //     : public A
      //     , public B
      //     , public C
      //
      // We also design the rules to 'work' for initialization lists, e.g.
      //
      //    Foo()
      //    : foo_(foo),
      //      bar_(bar),
      //      baz_(baz)
      if (/^\s*\{/.test(line)) {

         // Bail if the previous line ends with a semi-colon (don't auto-outdent)
         if (/;\s*$/.test(lastLine)) {
            return;
         }

         var scopeRow = this.$heuristics.getRowForOpenBraceIndent(
            session,
            row
         );

         if (scopeRow !== null) {

            // Walk over un-informative lines
            var scopeLine = this.$heuristics.getLineSansComments(doc, scopeRow);
            while (/^\s*$/.test(scopeLine) ||
                   /^\s*\(.*\)\s*$/.test(scopeLine) ||
                   /:\s*$/.test(scopeLine)) {
               scopeRow--;
               scopeLine = this.$heuristics.getLineSansComments(doc, scopeRow);
               if (scopeRow <= 0) break;
            }

            // If the first line had a continuation token then the row is now -1;
            // nudge it back up
            if (scopeRow < 0) scopeRow = 0;

            // Don't indent if the 'class' has an associated open brace. This ensures
            // that we get outdenting e.g.
            //
            //     class Foo {
            //         {
            //         ^
            //
            // , ie, we avoid putting the open brace at indentation of 'class' token.
            if (this.$heuristics.getLineSansComments(doc, scopeRow).indexOf("{") === -1) {
               this.setIndent(session, row, scopeRow);
               return;
            }
         }

      }

      // Default matching rules
      var match = line.match(/^(\s*\})$/);
      if (!match) return 0;

      var column = match[1].length;
      var openBracePos = session.findMatchingBracket({
         row: row,
         column: column
      });

      if (!openBracePos) return 0;

      // Just use the indentation of the matching brace
      if (openBracePos.row >= 0) {
         this.setIndent(session, row, openBracePos.row);
         return;
      }
      
   };

   this.$getIndent = function(line) {
      var match = line.match(/^(\s+)/);
      if (match) {
         return match[1];
      }
      return "";
   };

}).call(MatchingBraceOutdent.prototype);

exports.MatchingBraceOutdent = MatchingBraceOutdent;
});
