/*!
 * Copyright 2017 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {GoogleError, Status} from 'google-gax';

import * as proto from '../protos/firestore_v1_proto_api';

import {ExponentialBackoff} from './backoff';
import {DocumentSnapshot, Precondition} from './document';
import {Firestore, WriteBatch} from './index';
import {logger} from './logger';
import {FieldPath, validateFieldPath} from './path';
import {
  DocumentReference,
  Query,
  QuerySnapshot,
  validateDocumentReference,
} from './reference';
import {
  DocumentData,
  Precondition as PublicPrecondition,
  ReadOptions,
  SetOptions,
  UpdateData,
} from './types';
import {isObject, isPlainObject} from './util';
import {
  invalidArgumentMessage,
  RequiredArgumentOptions,
  validateMinNumberOfArguments,
  validateOptional,
} from './validate';

import api = proto.google.firestore.v1;
import {UpdateBuilder} from "./update-builder";

/*!
 * Error message for transactional reads that were executed after performing
 * writes.
 */
const READ_AFTER_WRITE_ERROR_MSG =
  'Firestore transactions require all reads to be executed before all writes.';

/**
 * A reference to a transaction.
 *
 * The Transaction object passed to a transaction's updateFunction provides
 * the methods to read and write data within the transaction context. See
 * [runTransaction()]{@link Firestore#runTransaction}.
 *
 * @class
 */
export class Transaction extends UpdateBuilder<Transaction> {
  private _backoff: ExponentialBackoff;
  private _requestTag: string;
  private _transactionId?: Uint8Array;

  /**
   * @hideconstructor
   *
   * @param firestore The Firestore Database client.
   * @param requestTag A unique client-assigned identifier for the scope of
   * this transaction.
   */
  constructor(firestore: Firestore, requestTag: string) {
    super(firestore, 500);
    this._requestTag = requestTag;
    this._backoff = new ExponentialBackoff();
  }

  wrapResult(): Transaction {
    return this
  }
  
  /**
   * Retrieves a query result. Holds a pessimistic lock on all returned
   * documents.
   *
   * @param {Query} query A query to execute.
   * @return {Promise<QuerySnapshot>} A QuerySnapshot for the retrieved data.
   */
  get<T>(query: Query<T>): Promise<QuerySnapshot<T>>;

  /**
   * Reads the document referenced by the provided `DocumentReference.`
   * Holds a pessimistic lock on the returned document.
   *
   * @param {DocumentReference} documentRef A reference to the document to be read.
   * @return {Promise<DocumentSnapshot>}  A DocumentSnapshot for the read data.
   */
  get<T>(documentRef: DocumentReference<T>): Promise<DocumentSnapshot<T>>;

  /**
   * Retrieve a document or a query result from the database. Holds a
   * pessimistic lock on all returned documents.
   *
   * @param {DocumentReference|Query} refOrQuery The document or query to
   * return.
   * @returns {Promise} A Promise that resolves with a DocumentSnapshot or
   * QuerySnapshot for the returned documents.
   *
   * @example
   * firestore.runTransaction(transaction => {
   *   let documentRef = firestore.doc('col/doc');
   *   return transaction.get(documentRef).then(doc => {
   *     if (doc.exists) {
   *       transaction.update(documentRef, { count: doc.get('count') + 1 });
   *     } else {
   *       transaction.create(documentRef, { count: 1 });
   *     }
   *   });
   * });
   */
  get<T>(
    refOrQuery: DocumentReference<T> | Query<T>
  ): Promise<DocumentSnapshot<T> | QuerySnapshot<T>> {
    if (!this.isEmpty) {
      throw new Error(READ_AFTER_WRITE_ERROR_MSG);
    }

    if (refOrQuery instanceof DocumentReference) {
      return this._firestore
        .getAll_(
          [refOrQuery],
          /* fieldMask= */ null,
          this._requestTag,
          this._transactionId
        )
        .then(res => {
          return Promise.resolve(res[0]);
        });
    }

    if (refOrQuery instanceof Query) {
      return refOrQuery._get(this._transactionId);
    }

    throw new Error(
      'Value for argument "refOrQuery" must be a DocumentReference or a Query.'
    );
  }

  /**
   * Retrieves multiple documents from Firestore. Holds a pessimistic lock on
   * all returned documents.
   *
   * The first argument is required and must be of type `DocumentReference`
   * followed by any additional `DocumentReference` documents. If used, the
   * optional `ReadOptions` must be the last argument.
   *
   * @param {...DocumentReference|ReadOptions} documentRefsOrReadOptions The
   * `DocumentReferences` to receive, followed by an optional field mask.
   * @returns {Promise<Array.<DocumentSnapshot>>} A Promise that
   * contains an array with the resulting document snapshots.
   *
   * @example
   * let firstDoc = firestore.doc('col/doc1');
   * let secondDoc = firestore.doc('col/doc2');
   * let resultDoc = firestore.doc('col/doc3');
   *
   * firestore.runTransaction(transaction => {
   *   return transaction.getAll(firstDoc, secondDoc).then(docs => {
   *     transaction.set(resultDoc, {
   *       sum: docs[0].get('count') + docs[1].get('count')
   *     });
   *   });
   * });
   */
  getAll<T>(
    ...documentRefsOrReadOptions: Array<DocumentReference<T> | ReadOptions>
  ): Promise<Array<DocumentSnapshot<T>>> {
    if (!this.isEmpty) {
      throw new Error(READ_AFTER_WRITE_ERROR_MSG);
    }

    validateMinNumberOfArguments('Transaction.getAll', arguments, 1);

    const {documents, fieldMask} = parseGetAllArguments(
      documentRefsOrReadOptions
    );

    return this._firestore.getAll_(
      documents,
      fieldMask,
      this._requestTag,
      this._transactionId
    );
  }

  /**
   * Starts a transaction and obtains the transaction id from the server.
   *
   * @private
   */
  begin(): Promise<void> {
    const request: api.IBeginTransactionRequest = {
      database: this._firestore.formattedName,
    };

    if (this._transactionId) {
      request.options = {
        readWrite: {
          retryTransaction: this._transactionId,
        },
      };
    }

    return this._firestore
      .request<api.IBeginTransactionRequest, api.IBeginTransactionResponse>(
        'beginTransaction',
        request,
        this._requestTag
      )
      .then(resp => {
        this._transactionId = resp.transaction!;
      });
  }

  /**
   * Commits all queued-up changes in this transaction and releases all locks.
   *
   * @private
   */
  commit(): Promise<void> {
    return this.commit_({
        transactionId: this._transactionId,
        requestTag: this._requestTag,
      })
      .then(() => {});
  }

  /**
   * Releases all locks and rolls back this transaction.
   *
   * @private
   */
  rollback(): Promise<void> {
    const request = {
      database: this._firestore.formattedName,
      transaction: this._transactionId,
    };

    return this._firestore.request('rollback', request, this._requestTag);
  }

  /**
   * Executes `updateFunction()` and commits the transaction with retry.
   *
   * @private
   * @param updateFunction The user function to execute within the transaction
   * context.
   * @param maxAttempts The maximum number of attempts for this transaction.
   */
  async runTransaction<T>(
    updateFunction: (transaction: Transaction) => Promise<T>,
    maxAttempts: number
  ): Promise<T> {
    let result: T;
    let lastError: GoogleError | undefined = undefined;

    for (let attempt = 0; attempt < maxAttempts; ++attempt) {
      if (lastError) {
        logger(
          'Firestore.runTransaction',
          this._requestTag,
          `Retrying transaction after error:`,
          lastError
        );
      }

      this._reset();
      await this.maybeBackoff(lastError);

      await this.begin();

      try {
        const promise = updateFunction(this);
        if (!(promise instanceof Promise)) {
          throw new Error(
            'You must return a Promise in your transaction()-callback.'
          );
        }
        result = await promise;
        await this.commit();
        return result;
      } catch (err) {
        logger(
          'Firestore.runTransaction',
          this._requestTag,
          'Rolling back transaction after callback error:',
          err
        );

        await this.rollback();

        if (isRetryableTransactionError(err)) {
          lastError = err;
        } else {
          return Promise.reject(err); // Callback failed w/ non-retryable error
        }
      }
    }

    logger(
      'Firestore.runTransaction',
      this._requestTag,
      'Transaction not eligible for retry, returning error: %s',
      lastError
    );
    return Promise.reject(lastError);
  }

  /**
   * Delays further operations based on the provided error.
   *
   * @private
   * @return A Promise that resolves after the delay expired.
   */
  private async maybeBackoff(error?: GoogleError) {
    if (error && error.code === Status.RESOURCE_EXHAUSTED) {
      this._backoff.resetToMax();
    }
    await this._backoff.backoffAndWait();
  }
}

/**
 * Parses the arguments for the `getAll()` call supported by both the Firestore
 * and Transaction class.
 *
 * @private
 * @param documentRefsOrReadOptions An array of document references followed by
 * an optional ReadOptions object.
 */
export function parseGetAllArguments<T>(
  documentRefsOrReadOptions: Array<DocumentReference<T> | ReadOptions>
): {documents: Array<DocumentReference<T>>; fieldMask: FieldPath[] | null} {
  let documents: Array<DocumentReference<T>>;
  let readOptions: ReadOptions | undefined = undefined;

  if (Array.isArray(documentRefsOrReadOptions[0])) {
    throw new Error(
      'getAll() no longer accepts an array as its first argument. ' +
        'Please unpack your array and call getAll() with individual arguments.'
    );
  }

  if (
    documentRefsOrReadOptions.length > 0 &&
    isPlainObject(
      documentRefsOrReadOptions[documentRefsOrReadOptions.length - 1]
    )
  ) {
    readOptions = documentRefsOrReadOptions.pop() as ReadOptions;
    documents = documentRefsOrReadOptions as Array<DocumentReference<T>>;
  } else {
    documents = documentRefsOrReadOptions as Array<DocumentReference<T>>;
  }

  for (let i = 0; i < documents.length; ++i) {
    validateDocumentReference(i, documents[i]);
  }

  validateReadOptions('options', readOptions, {optional: true});
  const fieldMask =
    readOptions && readOptions.fieldMask
      ? readOptions.fieldMask.map(fieldPath =>
          FieldPath.fromArgument(fieldPath)
        )
      : null;
  return {fieldMask, documents};
}

/**
 * Validates the use of 'options' as ReadOptions and enforces that 'fieldMask'
 * is an array of strings or field paths.
 *
 * @private
 * @param arg The argument name or argument index (for varargs methods).
 * @param value The input to validate.
 * @param options Options that specify whether the ReadOptions can be omitted.
 */
function validateReadOptions(
  arg: number | string,
  value: unknown,
  options?: RequiredArgumentOptions
): void {
  if (!validateOptional(value, options)) {
    if (!isObject(value)) {
      throw new Error(
        `${invalidArgumentMessage(arg, 'read option')} Input is not an object.'`
      );
    }

    const options = value as {[k: string]: unknown};

    if (options.fieldMask !== undefined) {
      if (!Array.isArray(options.fieldMask)) {
        throw new Error(
          `${invalidArgumentMessage(
            arg,
            'read option'
          )} "fieldMask" is not an array.`
        );
      }

      for (let i = 0; i < options.fieldMask.length; ++i) {
        try {
          validateFieldPath(i, options.fieldMask[i]);
        } catch (err) {
          throw new Error(
            `${invalidArgumentMessage(
              arg,
              'read option'
            )} "fieldMask" is not valid: ${err.message}`
          );
        }
      }
    }
  }
}

function isRetryableTransactionError(error: GoogleError): boolean {
  if (error.code !== undefined) {
    // This list is based on https://github.com/firebase/firebase-js-sdk/blob/master/packages/firestore/src/core/transaction_runner.ts#L112
    switch (error.code) {
      case Status.ABORTED:
      case Status.CANCELLED:
      case Status.UNKNOWN:
      case Status.DEADLINE_EXCEEDED:
      case Status.INTERNAL:
      case Status.UNAVAILABLE:
      case Status.UNAUTHENTICATED:
      case Status.RESOURCE_EXHAUSTED:
        return true;
      default:
        return false;
    }
  }
  return false;
}
