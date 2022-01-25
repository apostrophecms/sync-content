const _ = require('lodash');

// Code borrowed verbatim from the workflow module

module.exports = (self, options) => {
  // Given a doc, find all joins related to that doc: those in its own schema,
  // or in the schemas of its own widgets. These are returned as an array of
  // objects with `doc` and `field` properties, where `doc` may be the doc
  // itself or a widget within it, and `field` is the schema field definition
  // of the join. Only forward joins are returned.

  self.findJoinsInDoc = function(doc) {
    return self.findJoinsInDocSchema(doc).concat(self.findJoinsInAreas(doc));
  };

  // Given a doc, invoke `findJoinsInSchema` with that doc and its schema according to
  // its doc type manager, and return the result.

  self.findJoinsInDocSchema = function(doc) {
    if (!doc.type) {
      // Cannot determine schema, so we cannot fetch joins;
      // don't crash, so we behave reasonably if very light
      // projections are present
      return [];
    }
    console.log('---> ' + doc.type);
    var schema = self.apos.docs.getManager(doc.type).schema;
    return self.findJoinsInSchema(doc, schema);
  };

  // Given a doc, find joins in the schemas of widgets contained in the
  // areas of that doc and  return an array in which each element is an object with
  // `doc` and `field` properties. `doc` is a reference to the individual widget
  // in question, and `field` is the join field definition for that widget.
  // Only forward joins are returned.

  self.findJoinsInAreas = function(doc) {
    var widgets = [];
    self.apos.areas.walk(doc, function(area, dotPath) {
      widgets = widgets.concat(area.items);
    });
    var joins = [];
    _.each(widgets, function(widget) {
      if (!widget.type) {
        // Don't crash on bad data or strange projections etc.
        return;
      }
      var manager = self.apos.areas.getWidgetManager(widget.type);
      if (!manager) {
        // We already warn about obsolete widgets elsewhere, don't crash
        return;
      }
      var schema = manager.schema;
      joins = joins.concat(self.findJoinsInSchema(widget, schema));
    });
    return joins;
  };

  // Given a doc (or widget) and a schema, find joins described by that schema and
  // return an array in which each element is an object with
  // `doc`, `field` and `value` properties. `doc` is a reference to the doc
  // passed to this method, `field` is a field definition, and `value` is the
  // value of the join if available (the doc was loaded with joins).
  //
  // Only forward joins are returned.

  self.findJoinsInSchema = function(doc, schema) {
    var fromArrays = [];
    return _.map(
      _.filter(
        schema, function(field) {
          if ((field.type === 'joinByOne') || (field.type === 'joinByArray')) {
            return true;
          }
          if (field.type === 'array') {
            _.each(doc[field.name] || [], function(doc) {
              fromArrays = fromArrays.concat(self.findJoinsInSchema(doc, field.schema));
            });
          }
          if (field.type === 'object' && typeof doc[field.name] === 'object') {
            fromArrays = fromArrays.concat(self.findJoinsInSchema(doc[field.name], field.schema));
          }
        }
      ), function(field) {
        return { doc: doc, field: field, value: doc[field.name] };
      }
    ).concat(fromArrays);
  };
};
