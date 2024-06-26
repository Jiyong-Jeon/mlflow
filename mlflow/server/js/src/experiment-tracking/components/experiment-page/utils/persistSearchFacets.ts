import { isArray, isObject } from 'lodash';
import QueryString, { IParseOptions } from 'qs';
import LocalStorageUtils from '../../../../common/utils/LocalStorageUtils';
import Utils from '../../../../common/utils/Utils';

import { SearchExperimentRunsFacetsState } from '../models/SearchExperimentRunsFacetsState';
import {
  deserializeFieldsFromLocalStorage,
  deserializeFieldsFromQueryString,
  serializeFieldsToLocalStorage,
  serializeFieldsToQueryString,
} from './persistSearchFacets.serializers';
import { ExperimentPageUIStateV2, createExperimentPageUIStateV2 } from '../models/ExperimentPageUIStateV2';
import {
  ExperimentPageSearchFacetsStateV2,
  createExperimentPageSearchFacetsStateV2,
} from '../models/ExperimentPageSearchFacetsStateV2';

const KNOWN_STATE_KEYS = Object.keys(new SearchExperimentRunsFacetsState());

/**
 * Function used by QueryString.parse(), implements better handling of booleans and undefined values
 */
const urlParserDecoder: IParseOptions['decoder'] = (str, defaultDecoder, _, type) => {
  if (type === 'value') {
    if (str === 'true') {
      return true;
    } else if (str === 'false') {
      return false;
    } else if (str === undefined) {
      return '';
    }
  }
  return defaultDecoder(str);
};

/**
 * Function used for merging two facets search states.
 */
const mergeFacetsStates = (
  base: SearchExperimentRunsFacetsState,
  object: Partial<SearchExperimentRunsFacetsState>,
): SearchExperimentRunsFacetsState =>
  Object.assign(new SearchExperimentRunsFacetsState(), {
    ...base,
    ...object,
  });

/**
 * Performs basic checks on partial facets state model. Returns false if
 * fields expected to be objects or arrays are not what they are supposed to be.
 */
function validateFacetsState(model: Partial<SearchExperimentRunsFacetsState>) {
  if (model.runsExpanded && !isObject(model.runsExpanded)) {
    return false;
  }

  if (model.selectedColumns && !isArray(model.selectedColumns)) {
    return false;
  }

  return true;
}

/**
 * Persists current facets state in local storage.
 */
function persistLocalStorage(data: Partial<SearchExperimentRunsFacetsState>, idKey: string) {
  // TODO: decide if we want to use LocalStorageUtils store or fall back to direct use of localStorage
  const localStorageInstance = LocalStorageUtils.getStoreForComponent('ExperimentPage', idKey);
  const sortFilterModelToSave = serializeFieldsToLocalStorage(data);
  localStorageInstance.saveComponentState(sortFilterModelToSave);
}

/**
 * Creates the URL query string representing the current search facets state.
 */
function createPersistedQueryString(
  sortFilterModelToSave: Partial<SearchExperimentRunsFacetsState> & { experiments?: any },
) {
  const serializedSortFilterModelToSave = serializeFieldsToQueryString(sortFilterModelToSave);

  return QueryString.stringify(serializedSortFilterModelToSave, {
    addQueryPrefix: true,
    arrayFormat: 'comma',
    encodeValuesOnly: true,
  });
}

/**
 * Consumes object containing all fields parsed from search query and
 * separates those relevant to the search state from the rest.
 */
function extractExperimentSearchFacetsState<
  // Template for partial state type
  PartialState extends Partial<SearchExperimentRunsFacetsState>,
  // Template for partial state + the rest type
  URLObject extends PartialState,
>(rawURLSearchData: URLObject) {
  const stateData: PartialState = {} as PartialState;
  const restData: Omit<URLObject, keyof PartialState> = {} as Omit<URLObject, keyof PartialState>;

  for (const field in rawURLSearchData) {
    if (rawURLSearchData.hasOwnProperty(field)) {
      const isKnownField = KNOWN_STATE_KEYS.includes(field);
      Object.assign(isKnownField ? stateData : restData, { [field]: rawURLSearchData[field] });
    }
  }
  return { stateData, restData };
}

/**
 * Persists current facets state in local storage and returns query string to be persisted in the URL.
 */
export function persistExperimentSearchFacetsState(
  sortFilterModelToSave: SearchExperimentRunsFacetsState,
  idKey: string,
  currentLocationSearch = '',
) {
  // Extract all current query params, append and persist those relevant to the runs table.
  const currentParameters = QueryString.parse(currentLocationSearch, {
    ignoreQueryPrefix: true,
    comma: true,
    arrayLimit: 500,
    decoder: urlParserDecoder,
  });
  persistLocalStorage(sortFilterModelToSave, idKey);
  return createPersistedQueryString({ ...currentParameters, ...sortFilterModelToSave });
}

/**
 * Restores facets state from local storage and URL query string.
 *
 * @param location extracted e.g. from useLocation
 * @param idKey unique key for the storage
 * @param persistCombinedToLocalStorage if true, the combined state will be re-persisted to local storage
 */
export function restoreExperimentSearchFacetsState(locationSearch: string, idKey: string) {
  // Step 1: prepare base value as a plain object
  let baseState = { ...new SearchExperimentRunsFacetsState() };

  // Step 2: extract current state from local storage
  try {
    // TODO: decide if we want to use LocalStorageUtils store or fall back to direct use of localStorage
    const localStorageInstance = LocalStorageUtils.getStoreForComponent('ExperimentPage', idKey);
    const rawLocalStorageValue = localStorageInstance.loadComponentState();
    if (validateFacetsState(rawLocalStorageValue)) {
      const localStorageValue = deserializeFieldsFromLocalStorage(rawLocalStorageValue);
      // Merge it with the base state only if it's valid
      baseState = mergeFacetsStates(baseState, localStorageValue);
    }
  } catch {
    Utils.logErrorAndNotifyUser(`Error: malformed persisted search state for experiment(s) ${idKey}`);
  }

  // Preliminarily decode the search query, despite QueryString.parse doing the same.
  // In certain scenarios the search values can arrive double-encoded
  // (e.g. after being redirected from the login page) so by doing this, we ensure
  // that the values will be properly decoded at the end.
  const normalizedLocationSearch = decodeURIComponent(locationSearch);

  // Step 3: extract data from URL...
  const rawUrlData = QueryString.parse(normalizedLocationSearch, {
    ignoreQueryPrefix: true,
    comma: true,
    arrayLimit: 500,
    decoder: urlParserDecoder,
  });
  const { restData, stateData } = extractExperimentSearchFacetsState(rawUrlData);

  const transformedStateData = deserializeFieldsFromQueryString(stateData);

  // If the is at least one relevant query params in URL, take URL into consideration.
  const isURLStateEmpty = Object.keys(transformedStateData).length < 1;
  if (!isURLStateEmpty) {
    // We need merge specified fields from the URL query to the empty state.
    // In certain scenarios, parts of the state (e.g. empty arrays) are not being persisted in the URL
    // and we need to regenerate them.
    const urlState = Object.assign(new SearchExperimentRunsFacetsState(), transformedStateData);
    baseState = mergeFacetsStates(baseState, urlState);
  }

  // Step 4: persist combined state again
  persistLocalStorage(baseState, idKey);

  return {
    state: baseState,
    queryString: createPersistedQueryString({ ...restData, ...baseState }),
  };
}

// TODO(ML-35962): remove all above functions after the migration to the new view state model is complete
/**
 * Loads current view state (UI state, view state) in the local storage.
 */
export function loadExperimentViewState(idKey: string) {
  try {
    const localStorageInstance = LocalStorageUtils.getStoreForComponent('ExperimentPage', idKey);
    return localStorageInstance.loadComponentState();
  } catch {
    Utils.logErrorAndNotifyUser(`Error: malformed persisted search state for experiment(s) ${idKey}`);

    return {
      ...createExperimentPageUIStateV2(),
      ...createExperimentPageSearchFacetsStateV2(),
    };
  }
}

/**
 * Persists view state (UI state, view state) in the local storage.
 */
export function saveExperimentViewState(
  data: ExperimentPageUIStateV2 & ExperimentPageSearchFacetsStateV2,
  idKey: string,
) {
  const localStorageInstance = LocalStorageUtils.getStoreForComponent('ExperimentPage', idKey);
  localStorageInstance.saveComponentState(data);
}
