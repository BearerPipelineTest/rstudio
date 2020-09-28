/*
 * insert_citation_picker.ts
 *
 * Copyright (C) 2020 by RStudio, PBC
 *
 * Unless you have received this program directly from RStudio pursuant
 * to the terms of a commercial license agreement with RStudio, then
 * this program is licensed to you under the terms of version 3 of the
 * GNU Affero General Public License. This program is distributed WITHOUT
 * ANY EXPRESS OR IMPLIED WARRANTY, INCLUDING THOSE OF NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE. Please refer to the
 * AGPL (http://www.gnu.org/licenses/agpl-3.0.txt) for more details.
 *
 */


import React from "react";
import ReactDOM from "react-dom";

import { Node as ProsemirrorNode } from 'prosemirror-model';

import { BibliographyFile, BibliographyManager, bibliographyTypes, bibliographyFileForPath, BibliographySource } from "../../api/bibliography/bibliography";
import { kInvalidCiteKeyChars } from "../../api/cite";
import { changeExtension } from "../../api/path";
import { EditorServer } from "../../api/server";
import { EditorUI } from "../../api/ui";
import { WidgetProps } from "../../api/widgets/react";
import { TagInput, TagItem } from "../../api/widgets/tag-input";
import { NavigationTreeNode, containsChild, NavigationTree } from "../../api/widgets/navigation-tree";
import { DialogButtons } from "../../api/widgets/dialog-buttons";

import { CitationSourcePanelProps, CitationSourcePanelProvider, CitationListEntry, CitationSourceListStatus, BibliographySourceProvider } from "./source_panels/insert_citation-source-panel";
import { bibliographySourcePanel } from "./source_panels/insert_citation-source-panel-bibliography";
import { doiSourcePanel } from "./source_panels/insert_citation-source-panel-doi";
import { crossrefSourcePanel } from "./source_panels/insert_citation-source-panel-crossref";
import { pubmedSourcePanel } from "./source_panels/insert_citation-source-panel-pubmed";
import { dataciteSourcePanel } from "./source_panels/insert_citation-source-panel-datacite";
import { CitationBibliographyPicker } from "./insert_citation-bibliography-picker";

import './insert_citation.css';
import debounce from "lodash.debounce";



// When the dialog has completed, it will return this result
// If the dialog is canceled no result will be returned
export interface InsertCitationDialogResult {
  bibliographySources: BibliographySource[];
  bibliography: BibliographyFile;
  selectionKey?: string;
}

// Show the insert citation dialog and returns the 
// items that should be inserted, the bibliography in which to write them
// and the last selected position in the tree
export async function showInsertCitationDialog(
  ui: EditorUI,
  doc: ProsemirrorNode,
  bibliographyManager: BibliographyManager,
  server: EditorServer,
  performInsertCitations: (result: InsertCitationDialogResult) => Promise<void>,
  initiallySelectedNodeKey?: string
): Promise<boolean> {

  // The result that will be returned to the called
  let result: InsertCitationDialogResult | undefined;

  // Present the dialog
  const performInsert = await ui.dialogs.htmlDialog(
    "Insert Citation",
    "Insert",
    (containerWidth: number, containerHeight: number, confirm: VoidFunction, cancel: VoidFunction, showProgress: (message: string) => void, hideProgress: VoidFunction) => {

      const kMaxHeight = 650;
      const kMaxWidth = 900;
      const kMaxHeightProportion = .9;
      const kdialogPaddingIncludingButtons = 70;

      const windowHeight = containerHeight;
      const windowWidth = containerWidth;

      const height = Math.min(kMaxHeight, windowHeight * kMaxHeightProportion - kdialogPaddingIncludingButtons);
      const width = Math.max(Math.min(kMaxWidth, windowWidth * .9), 550);

      const container = window.document.createElement('div');
      container.className = 'pm-default-theme';

      // Provide the providers top the dialog and then refresh the bibliography and reload
      // the items
      const providersForBibliography = (writable: boolean) => {
        return writable ? [
          bibliographySourcePanel(doc, ui, bibliographyManager),
          doiSourcePanel(ui, bibliographyManager, server.doi),
          crossrefSourcePanel(ui, bibliographyManager, server.crossref, server.doi),
          dataciteSourcePanel(ui, bibliographyManager, server.datacite, server.doi),
          pubmedSourcePanel(ui, bibliographyManager, server.pubmed, server.doi),] :
          [bibliographySourcePanel(doc, ui, bibliographyManager)];
      };

      // Provide a configuration stream that will update after the bibliography loads
      let updatedConfiguration: InsertCitationPanelConfiguration | undefined;
      const configurationStream: InsertCitationPanelConfigurationStream = {
        current: {
          providers: providersForBibliography(bibliographyManager.allowsWrites()),
          bibliographyFiles: bibliographyManager.bibliographyFiles(doc, ui),
          existingIds: bibliographyManager.localSources().map(source => source.id)
        },
        stream: () => {
          return updatedConfiguration || null;
        }
      };

      // Load the bibliography and then update the configuration
      bibliographyManager.load(ui, doc, true).then(() => {
        updatedConfiguration = {
          providers: providersForBibliography(bibliographyManager.allowsWrites()),
          bibliographyFiles: bibliographyManager.bibliographyFiles(doc, ui),
          existingIds: bibliographyManager.localSources().map(source => source.id)
        };
      });

      // Handles the confirmation by the user
      const onOk = async (bibliographySourceProviders: BibliographySourceProvider[], bibliography: BibliographyFile, selectedNode: NavigationTreeNode) => {

        // Look through the items and see whether any will be slow
        // If some are slow, show progress
        const requiresProgress = bibliographySourceProviders.some(sourceProvider => sourceProvider.isSlowGeneratingBibliographySource);
        if (requiresProgress) {
          showProgress(ui.context.translateText(bibliographySourceProviders.length === 1 ? 'Creating bibliography entry...' : 'Creating bibliography entries...'));
        }

        // Generate bibliography sources for each of the entries
        const bibliographySources = await Promise.all(bibliographySourceProviders.map(sourceProvider => sourceProvider.toBibliographySource(sourceProvider.id)));
        result = {
          bibliographySources,
          bibliography,
          selectionKey: selectedNode.key
        };

        // Notify the caller to perform the inseration
        await performInsertCitations(result);

        // Clear progress
        if (requiresProgress) {
          hideProgress();
        }

        // Dismiss the dialog
        confirm();
      };

      container.style.width = width + 'px';
      ReactDOM.render(
        <InsertCitationPanel
          height={height}
          width={width}
          configuration={configurationStream}
          initiallySelectedNodeKey={initiallySelectedNodeKey}
          onOk={onOk}
          onCancel={cancel}
          doc={doc}
          ui={ui}
        />
        , container);
      return container;

    },
    () => {
      // Focus
      // dealt with in the React Component itself
    },
    () => {
      // Validation
      // User has to select a citation, everything else we can use defaults
      if (result && result.bibliographySources.length === 0) {
        return ui.context.translateText('Please select at least one citation to insert.');
      }
      return null;
    });

  // return the result to the caller
  if (performInsert && result) {
    return Promise.resolve(true);
  } else {
    return Promise.resolve(false);
  }
}

interface InsertCitationPanelConfiguration {
  providers: CitationSourcePanelProvider[];
  bibliographyFiles: BibliographyFile[];
  existingIds: string[];
}

interface InsertCitationPanelConfigurationStream {
  current: InsertCitationPanelConfiguration;
  stream: () => (InsertCitationPanelConfiguration | null);
}

// The picker is a full featured UI for finding and selecting citation data
// to be added to a document.
interface InsertCitationPanelProps extends WidgetProps {
  ui: EditorUI;
  doc: ProsemirrorNode;
  height: number;
  width: number;
  configuration: InsertCitationPanelConfigurationStream;
  initiallySelectedNodeKey?: string;
  onOk: (bibliographySourceProviders: BibliographySourceProvider[], bibliography: BibliographyFile, selectedNode: NavigationTreeNode) => void;
  onCancel: () => void;
}

interface InsertCitationPanelState {
  citations: CitationListEntry[];
  citationsToAdd: CitationListEntry[];
  selectedIndex: number;
  searchTerm: string;
  selectedNode: NavigationTreeNode;
  status: CitationSourceListStatus;
  statusMessage: string;
  existingBibliographyFile: BibliographyFile;
  createBibliographyFile: BibliographyFile;
}

interface InsertCitationPanelUpdateState {
  citations?: CitationListEntry[];
  citationsToAdd?: CitationListEntry[];
  selectedIndex?: number;
  searchTerm?: string;
  selectedNode?: NavigationTreeNode;
  status?: CitationSourceListStatus;
  statusMessage?: string;
  existingBibliographyFile?: BibliographyFile;
  createBibliographyFile?: BibliographyFile;
}

export const InsertCitationPanel: React.FC<InsertCitationPanelProps> = props => {

  // The configuration state of this panel
  const [insertCitationConfiguration, setInsertCitationConfiguration] = React.useState<InsertCitationPanelConfiguration>(props.configuration.current);

  // The source data for the tree
  const treeSourceData = insertCitationConfiguration.providers.map(panel => panel.treeNode());

  // The selected provider / panel for the dialog
  const defaultNode = nodeForKey(treeSourceData, props.initiallySelectedNodeKey);
  const [selectedPanelProvider, setSelectedPanelProvider] = React.useState<CitationSourcePanelProvider>(panelForNode(insertCitationConfiguration.providers, defaultNode) || insertCitationConfiguration.providers[0]);

  // Holder of the dialog state
  const [insertCitationPanelState, setInsertCitationPanelState] = React.useState<InsertCitationPanelState>(
    {
      citations: [],
      citationsToAdd: [],
      selectedIndex: -1,
      searchTerm: '',
      selectedNode: defaultNode || selectedPanelProvider.treeNode(),
      status: CitationSourceListStatus.default,
      statusMessage: selectedPanelProvider.placeHolderMessage || '',
      existingBibliographyFile: props.configuration.current.bibliographyFiles[0],
      createBibliographyFile: bibliographyFileForPath(changeExtension('references.json', props.ui.prefs.bibliographyDefaultType() || bibliographyTypes(props.ui)[0].extension), props.ui)
    }
  );

  // Core method to update dialog state
  const updateState = (updatedState: InsertCitationPanelUpdateState) => {
    const newState = {
      ...insertCitationPanelState,
      ...updatedState
    };
    setInsertCitationPanelState(newState);
  };

  // The dialog intelligently manages and merges the selected item and the explicitly added items
  // This is the merged set of citations based upon the explicitly chosen and currently selected citations
  const displayedCitations = insertCitationPanelState.citations.filter(citation => !insertCitationPanelState.citationsToAdd.includes(citation));
  const selectedCitation = insertCitationPanelState.selectedIndex > -1 ? displayedCitations[insertCitationPanelState.selectedIndex] : undefined;
  const mergedCitationsToAdd = mergeCitations(insertCitationPanelState.citationsToAdd, selectedCitation);
  const existingCitationIds = [...insertCitationConfiguration.existingIds, ...mergedCitationsToAdd.map(citation => citation.id)];

  // The initial setting of focus and loading of data for the panel. 
  const panelRef = React.useRef<any>(undefined);

  // When the stream of configuration changes is actually loaded, we need to refresh the search
  // results to reflect the new configuration. The below refs basically:
  // 1) Capture the timer itself so only timer is created and it will be properly canceled
  // 2) Captures the up to date state in the callback that will be used to refresh the search results -
  //    If we don't refresh it each render, it will capture the state the time it was created
  const streamTimerId = React.useRef<NodeJS.Timeout>();
  const refreshSearchCallback = React.useRef<VoidFunction>();
  React.useEffect(() => {
    refreshSearchCallback.current = () => {
      // Once the configurations, refresh the search
      const defaultResults = selectedPanelProvider.typeAheadSearch(insertCitationPanelState.searchTerm, insertCitationPanelState.selectedNode, existingCitationIds);
      if (defaultResults) {
        updateState({
          searchTerm: '',
          citations: defaultResults?.citations || [],
          status: defaultResults?.status || CitationSourceListStatus.default,
          statusMessage: defaultResults?.statusMessage || selectedPanelProvider.placeHolderMessage,
        });
      }
    };
  });

  React.useEffect(() => {
    // Set initial focus
    if (panelRef.current) {
      setTimeout(() => {
        panelRef.current.focus();
      }, 200);
    }

    // Poll the configuration stream for updates
    // We need to keep the Timeout to clear around as ref so
    // it survives any renders
    streamTimerId.current = setInterval(() => {
      const result = props.configuration.stream();
      if (result !== null) {
        if (streamTimerId.current) {
          clearInterval(streamTimerId.current);
        }

        setInsertCitationConfiguration(result);
        const panelProvider = panelForNode(result.providers, insertCitationPanelState.selectedNode);
        if (panelProvider) {
          setSelectedPanelProvider(panelProvider);
        }
        if (refreshSearchCallback.current) {
          refreshSearchCallback.current();
        }
      }
    }, 200);

    // Set the default state to initialize the first search
    const searchResult = selectedPanelProvider.typeAheadSearch('', insertCitationPanelState.selectedNode, existingCitationIds);
    updateState({
      searchTerm: '',
      citations: searchResult?.citations || [],
      status: searchResult?.status || CitationSourceListStatus.default,
      statusMessage: searchResult?.statusMessage || selectedPanelProvider.placeHolderMessage
    });
  }, []);


  // When the user presses the insert button
  const onOk = () => {
    props.onOk(mergedCitationsToAdd, insertCitationPanelState.existingBibliographyFile || insertCitationPanelState.createBibliographyFile, insertCitationPanelState.selectedNode);
  };

  // Style properties
  const style: React.CSSProperties = {
    width: props.width + 'px',
    ...props.style,
  };

  // Figure out the panel height (the height of the main panel less padding and other elements)
  const panelHeight = props.height * .75;

  // In order to debounce typeahead search, we need to memoize the callback so the same debounce function will be
  // used even when renders happen. 
  const memoizedTypeaheadSearch = React.useCallback(debounce((searchTerm: string, selectedNode: NavigationTreeNode, existingIds: string[]) => {
    const searchResult = selectedPanelProvider.typeAheadSearch(searchTerm, selectedNode, existingIds);
    if (searchResult) {
      updateState({
        searchTerm,
        citations: searchResult?.citations,
        status: searchResult?.status,
        statusMessage: searchResult?.statusMessage,
        selectedNode
      });
    }
  }, 30), []);


  // The core props that will be passed to whatever the selected panel is
  // This implements the connection of the panel events and data and the
  // core dialog state
  const citationProps: CitationSourcePanelProps = {
    ui: props.ui,
    height: panelHeight,
    citations: displayedCitations,
    citationsToAdd: mergedCitationsToAdd,
    searchTerm: insertCitationPanelState.searchTerm,
    onSearchTermChanged: (term: string) => {
      updateState({ searchTerm: term });
      memoizedTypeaheadSearch(term, insertCitationPanelState.selectedNode, existingCitationIds);
    },
    onExecuteSearch: (searchTerm: string) => {
      updateState({ searchTerm, status: CitationSourceListStatus.inProgress, statusMessage: selectedPanelProvider.progressMessage });
      selectedPanelProvider.search(searchTerm, insertCitationPanelState.selectedNode, existingCitationIds).then((searchResult) => {
        updateState({ searchTerm, citations: searchResult?.citations, status: searchResult?.status, statusMessage: searchResult?.statusMessage, selectedIndex: -1 });
      });
    },
    onAddCitation: (citation: CitationListEntry) => {
      const newCitations = [...insertCitationPanelState.citationsToAdd, citation];
      updateState({ selectedIndex: -1, citationsToAdd: newCitations });
    },
    onRemoveCitation: (citation: CitationListEntry) => {
      deleteCitation(citation.id);
    },
    selectedIndex: insertCitationPanelState.selectedIndex,
    onSelectedIndexChanged: (index: number) => {
      updateState({ selectedIndex: index });
    },
    onConfirm: onOk,
    status: insertCitationPanelState.status,
    statusMessage: insertCitationPanelState.statusMessage,
    warningMessage: selectedPanelProvider.warningMessage || '',
    ref: panelRef
  };

  // This implements the connection of the dialog (non-provider panel) events and data and the
  // core dialog state
  const onNodeSelected = (node: NavigationTreeNode) => {
    const suggestedPanel = panelForNode(insertCitationConfiguration.providers, node);
    if (suggestedPanel) {
      const searchResult = suggestedPanel.typeAheadSearch('', node, existingCitationIds);
      updateState({
        searchTerm: '',
        citations: searchResult?.citations || [],
        status: searchResult?.status || CitationSourceListStatus.default,
        statusMessage: searchResult?.statusMessage || suggestedPanel.placeHolderMessage,
        selectedNode: node
      });

      if (suggestedPanel?.key !== selectedPanelProvider?.key) {
        setSelectedPanelProvider(suggestedPanel);
      }
    }
  };

  const deleteCitation = (id: string) => {
    const filteredCitations = insertCitationPanelState.citationsToAdd.filter(source => source.id !== id);
    updateState({ citationsToAdd: filteredCitations });
  };

  const onTagDeleted = (tag: TagItem) => {
    deleteCitation(tag.key);
  };

  const onTagChanged = (key: string, text: string) => {
    const targetSource = insertCitationPanelState.citationsToAdd.find(source => source.id === key);
    if (targetSource) {
      targetSource.id = text;
    }
  };

  const onTagValidate = (key: string, text: string) => {
    const invalidChars = text.match(kInvalidCiteKeyChars);
    if (invalidChars) {
      return props.ui.context.translateText("The citekey includes invalid characters such as a space or a special character.");
    }
    return null;
  };

  const onBibliographyFileChanged = (biblographyFile: BibliographyFile) => {
    updateState({ existingBibliographyFile: biblographyFile });
  };

  const onCreateBibliographyFileNameChanged = (fileName: string) => {
    updateState({ createBibliographyFile: bibliographyFileForPath(fileName, props.ui) });
  };

  // Support keyboard shortcuts for dismissing dialog
  const onKeyPress = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      onOk();
    }
  };

  // Esc can cause loss of focus so catch it early
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      props.onCancel();
    }
  };

  // Create the panel that should be displayed for the selected node of the tree
  const panelToDisplay = selectedPanelProvider ? React.createElement(selectedPanelProvider.panel, citationProps) : undefined;
  return (
    <div className='pm-cite-panel-container' style={style} onKeyPress={onKeyPress} onKeyDown={onKeyDown}>

      <div className='pm-cite-panel-cite-selection'>
        <div className='pm-cite-panel-cite-selection-sources pm-block-border-color pm-background-color'>
          <NavigationTree
            height={panelHeight}
            nodes={treeSourceData}
            selectedNode={insertCitationPanelState.selectedNode}
            onSelectedNodeChanged={onNodeSelected}
          />
        </div>
        <div className='pm-cite-panel-cite-selection-items'>
          {panelToDisplay}
        </div>
      </div>
      <div
        className='pm-cite-panel-selected-cites pm-block-border-color pm-background-color'
      >
        <TagInput
          tags={mergedCitationsToAdd.map(source => ({
            key: source.id,
            displayText: source.id,
            displayPrefix: '@',
            isEditable: source.isIdEditable
          }))}
          onTagDeleted={onTagDeleted}
          onTagChanged={onTagChanged}
          onTagValidate={onTagValidate}
          ui={props.ui}
          placeholder={props.ui.context.translateText('Selected Citation Keys')} />
      </div>
      <div className='pm-cite-panel-select-bibliography'>
        {
          // Only show the picker if there are either no bibliographies specified, or if there are writable bibliographies
          insertCitationConfiguration.bibliographyFiles.length === 0 || insertCitationConfiguration.bibliographyFiles.some(bibFile => bibFile?.writable) ?
            <CitationBibliographyPicker
              bibliographyTypes={bibliographyTypes(props.ui)}
              createBibliographyFileName={insertCitationPanelState.createBibliographyFile.displayPath}
              onCreateBibliographyFileNameChanged={onCreateBibliographyFileNameChanged}
              bibliographyFiles={insertCitationConfiguration.bibliographyFiles}
              onBiblographyFileChanged={onBibliographyFileChanged}
              ui={props.ui} /> : <div />
        }
        <DialogButtons
          okLabel={props.ui.context.translateText('Insert')}
          cancelLabel={props.ui.context.translateText('Cancel')}
          onOk={onOk}
          onCancel={props.onCancel} />
      </div>
    </div>
  );
};

// Finds the panel associated with the selected tree node
const panelForNode = (sourcePanels: CitationSourcePanelProvider[], node?: NavigationTreeNode) => {
  if (node) {
    const panelItem = sourcePanels.find(panel => {
      const panelTreeNode = panel.treeNode();
      return containsChild(node.key, panelTreeNode);
    });
    return panelItem;
  } else {
    return undefined;
  }
};

// Given a key, find the node associated with the key (useful for restoring a selected node from a key)
const nodeForKey = (nodes: NavigationTreeNode[], key?: string): NavigationTreeNode | undefined => {
  if (!key) {
    return undefined;
  }

  for (const node of nodes) {
    if (node.key === key) {
      return node;
    }
    const childNode = nodeForKey(node.children, key);
    if (childNode) {
      return childNode;
    }
  }
  return undefined;
};

// Merge the selected citation into the list that is displayed for add and filter it
// out of the citation list itself
const mergeCitations = (toAdd: CitationListEntry[], selected?: CitationListEntry) => {
  if (!selected) {
    return toAdd;
  } else {
    if (toAdd.map(citation => citation.id).includes(selected.id)) {
      return toAdd;
    } else {
      return (toAdd || []).concat(selected);
    }
  }
};


